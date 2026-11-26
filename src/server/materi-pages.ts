/**
 * Materi pages for Priming: the original page as an image, its OCR blocks,
 * and highlight boxes drawn by code (never by a model).
 *
 * Page PNGs and OCR output are cached per source hash in
 * <data>/materi-pages/<sha256>/ (<page>.png, ocr.json), shared with ingest.
 * OCR runs on demand, one page at a time, only when a page has none cached
 * (DeepSeek OCR, US$0.225 per 1,000 pages per the official docs).
 */

import fs from "node:fs";
import path from "node:path";

import { parseOcrBlocks, type MateriSourceEntry, type OcrBlock } from "../core/materi-ingest.ts";
import type { MateriPageView } from "../core/materi.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { deepseekOcr, materiPagesDir, readSources } from "./materi-ingest.ts";
import { sourcePdfPath } from "./materi-files.ts";
import { pdfPassword } from "./materi-passwords.ts";

const PAGE_DPI = 150;
const HIGHLIGHT = "#e5484d";

export interface PageDeps {
	render(pdfPath: string, page: number, password?: string): Promise<Buffer>;
	ocr(png: Buffer, name: string): Promise<string>;
}

const liveDeps: PageDeps = {
	render: async (pdfPath, page, password) => {
		const [out] = await getHeadless().renderPdfPages(pdfPath, [page], { dpi: PAGE_DPI, password });
		if (!out) throw new Error(`Page ${page} is outside the document.`);
		return out.png;
	},
	ocr: deepseekOcr,
};

function findSource(doc: string): MateriSourceEntry {
	const entry = readSources().docs.find((d) => d.doc === doc);
	if (!entry) throw new Error(`Unknown document "${doc}". Use the doc path exactly as materi_search printed it.`);
	if (!entry.pdf || !entry.sha256) throw new Error(`The original PDF of "${doc}" is not available, so its pages cannot be shown.`);
	const pdf = sourcePdfPath(entry) as string;
	if (!fs.existsSync(pdf)) throw new Error(`The original PDF of "${doc}" is missing at ${pdf}.`);
	return { ...entry, pdf };
}

function readOcrCache(dir: string): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(path.join(/* turbopackIgnore: true */ dir, "ocr.json"), "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

/** How long one call waits for a page's first OCR before answering without
 *  blocks. The OCR keeps running and caches its result, so the next call for
 *  that page is instant. Must stay under the materi tools' timeout
 *  (tool-execute TOOL_TIMEOUT_OVERRIDES_MS). Test seam. */
export const ocrBudgetMs = { current: 75_000 };

/** One OCR per page at a time: a second call for the same page (the model
 *  retrying while the first is still reading) waits for the same result
 *  instead of paying for the page again. */
const ocrInFlight = new Map<string, Promise<string>>();

function ocrOnce(dir: string, page: number, png: Buffer, deps: PageDeps): Promise<string> {
	const key = `${dir}|${page}`;
	const running = ocrInFlight.get(key);
	if (running) return running;
	const job = (async () => {
		const raw = await deps.ocr(png, `${page}.png`);
		const fresh = readOcrCache(dir);
		fresh[String(page)] = raw;
		fs.writeFileSync(path.join(/* turbopackIgnore: true */ dir, "ocr.json"), JSON.stringify(fresh));
		return raw;
	})().finally(() => ocrInFlight.delete(key));
	ocrInFlight.set(key, job);
	return job;
}

class StillReading extends Error {}

function within<T>(job: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new StillReading()), ms);
	});
	return Promise.race([job, late]).finally(() => clearTimeout(timer));
}

function pngSize(png: Buffer): { width: number; height: number } {
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Draws numbered boxes around the chosen blocks (boxes are 0-1000 normalized). */
export async function drawHighlights(png: Buffer, boxes: { n: number; box: [number, number, number, number] }[]): Promise<Buffer> {
	if (boxes.length === 0) return png;
	const { createCanvas, loadImage } = await import("@napi-rs/canvas");
	const image = await loadImage(png);
	const canvas = createCanvas(image.width, image.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(image, 0, 0);
	const line = Math.max(3, Math.round(image.width / 300));
	const pad = line * 2;
	const font = Math.max(16, Math.round(image.width / 45));
	ctx.lineWidth = line;
	ctx.strokeStyle = HIGHLIGHT;
	ctx.font = `bold ${font}px sans-serif`;
	ctx.textBaseline = "middle";
	ctx.textAlign = "center";
	for (const { n, box } of boxes) {
		const [x1, y1, x2, y2] = box;
		const x = Math.max(0, (x1 / 1000) * image.width - pad);
		const y = Math.max(0, (y1 / 1000) * image.height - pad);
		const w = Math.min(image.width - x, ((x2 - x1) / 1000) * image.width + pad * 2);
		const h = Math.min(image.height - y, ((y2 - y1) / 1000) * image.height + pad * 2);
		ctx.strokeRect(x, y, w, h);
		// The number sits outside the box, left of it at mid-height, so it never covers the boxed text.
		const r = font * 0.75;
		const cx = Math.min(image.width - r, Math.max(r, x - r - line));
		const cy = Math.min(image.height - r, Math.max(r, y + h / 2));
		ctx.fillStyle = HIGHLIGHT;
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = "#ffffff";
		ctx.fillText(String(n), cx, cy);
	}
	return canvas.toBuffer("image/png");
}

/**
 * The page as an image (with the chosen blocks boxed) plus its numbered
 * OCR blocks. OCR failure is not fatal: the page is still shown, without
 * blocks, and the note says why.
 */
export async function materiPage(
	doc: string,
	page: number,
	highlight: number[] = [],
	deps: PageDeps = liveDeps,
): Promise<MateriPageView> {
	const entry = findSource(doc);
	if (!Number.isInteger(page) || page < 1 || (entry.pages !== undefined && page > entry.pages)) {
		throw new Error(`Page ${page} is outside "${doc}"${entry.pages ? ` (${entry.pages} pages)` : ""}.`);
	}
	const dir = path.join(/* turbopackIgnore: true */ materiPagesDir(), entry.sha256 as string);
	fs.mkdirSync(dir, { recursive: true });
	const pngFile = path.join(/* turbopackIgnore: true */ dir, `${page}.png`);
	let png: Buffer;
	if (fs.existsSync(pngFile)) png = fs.readFileSync(pngFile);
	else {
		png = await deps.render(entry.pdf as string, page, pdfPassword(entry.sha256 ?? undefined));
		fs.writeFileSync(pngFile, png);
	}

	let blocks: OcrBlock[] | null = null;
	let note: string | undefined;
	const cache = readOcrCache(dir);
	let raw = cache[String(page)];
	if (raw === undefined) {
		const job = ocrOnce(dir, page, png, deps);
		job.catch(() => {}); // a late failure after the budget is not an unhandled rejection
		try {
			raw = await within(job, ocrBudgetMs.current);
		} catch (error) {
			note =
				error instanceof StillReading
					? "Blocks not ready yet: this page is still being read for the first time. Ask for it again in about a minute; it will be instant then."
					: `Blocks unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	if (raw !== undefined) blocks = parseOcrBlocks(raw);

	const wanted = [...new Set(highlight)];
	const boxes: { n: number; box: [number, number, number, number] }[] = [];
	const missing: number[] = [];
	for (const n of wanted) {
		const box = blocks?.[n - 1]?.box;
		if (box) boxes.push({ n, box });
		else missing.push(n);
	}
	if (missing.length > 0) {
		const why = blocks ? `no block with a box has number ${missing.join(", ")}` : "the page has no blocks";
		note = [note, `Not highlighted: ${why}.`].filter(Boolean).join(" ");
	}
	const shown = await drawHighlights(png, boxes);
	return { png: shown, ...pngSize(shown), blocks, highlighted: boxes.map((b) => b.n), ...(note ? { note } : {}) };
}

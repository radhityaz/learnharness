/**
 * Materi ingest: drop a PDF into the inbox, the rest runs on its own.
 *
 *   <data>/materi-inbox/<matkul>/.../*.pdf     (override: LH_MATERI_INBOX)
 *
 * Per new file: SHA-256 → skip when already indexed (old Belajar documents
 * are known by their source hash in sources.json) → skip when its text pages
 * are near copies of a document the course already has → text per page from the
 * PDF's text layer → weak pages rendered to PNG and sent to DeepSeek OCR
 * (raw output kept for Priming's boxes) → chunks (the old index's rule) →
 * Voyage document embeddings → appended to the course shard and FTS.
 * The original then moves to <data>/materi-files/<matkul>/ (materi-files.ts);
 * a byte-identical copy of a kept file is removed from the inbox.
 *
 * One file at a time, never in parallel with itself. Every outcome is one
 * line in <index>/ingest-log.jsonl with its page and token counts.
 * The DeepSeek key is read at call time (DEEPSEEK_API_KEY, env or key file)
 * and never written anywhere.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PATHS } from "../../config.ts";
import {
	chunkPage,
	docTitleFromFile,
	embedText,
	isDuplicateDoc,
	matchPages,
	matkulFromInboxPath,
	mostMatchedDoc,
	ocrToText,
	type IngestChunk,
	type MateriSourceEntry,
	type MateriSources,
	withPageContext,
} from "../core/materi-ingest.ts";
import { NEAR_COPY_MIN_WORDS, needsVision, pageWords } from "../core/pdf-index.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import type { PdfPage } from "../agent/subagents/pdf-markdown.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { keyValue } from "./keys.ts";
import { appendToMateriIndex, courseWordSets, embedDocuments, materiIndexDir } from "./materi-index.ts";
import { sourcePdfPath, storeSourcePdf } from "./materi-files.ts";
import { pdfPassword, readSidecar, savePdfPassword, sidecarStamp } from "./materi-passwords.ts";
import { isOfficeFile, officeConverter, type OfficeConverter } from "./office-convert.ts";

const DEEPSEEK_OCR_URL = "https://api.deepseek.com/v1/tools/ocr";
/** Documented account limit is 15 recognitions in progress; stay well under it. */
const OCR_CONCURRENCY = 4;
const OCR_TIMEOUT_MS = 190_000;
const OCR_DPI = 150;
const EMBED_BATCH = 32;
const MAX_PAGES = 2000;
/** A file modified more recently than this may still be copying. */
const SETTLE_MS = 30_000;
const SCAN_INTERVAL_MS = 120_000;

export interface IngestDeps {
	/** Pages as Markdown; null when the PDF cannot be read, "password" when it needs a (right) password. */
	convert(data: Uint8Array, password?: string): Promise<PdfPage[] | null | "password">;
	render(pdfPath: string, pages: number[], password?: string): Promise<{ page: number; png: Buffer }[]>;
	/** Raw OCR output for one page image. */
	ocr(png: Buffer, name: string): Promise<string>;
	embed(texts: string[]): Promise<{ vectors: Float32Array[]; tokens: number }>;
	now(): Date;
	/** Word/PowerPoint to PDF (default: LibreOffice or Microsoft Office, whichever is installed). */
	office?(): OfficeConverter | null;
	/** Word sets of the course's indexed chunks (default: read from the index). */
	courseWords?(matkul: string): { doc: string; words: ReadonlySet<string> }[];
}

export interface IngestOutcome {
	at: string;
	file: string;
	matkul: string | null;
	sha256?: string;
	status: "ingested" | "duplicate" | "skipped" | "failed";
	doc?: string;
	pages?: number;
	ocrPages?: number;
	chunks?: number;
	/** The Word/PowerPoint file this PDF was made from. */
	convertedFrom?: string;
	embedTokens?: number;
	note?: string;
}

export function materiInboxDir(): string {
	return process.env.LH_MATERI_INBOX
		? path.resolve(/* turbopackIgnore: true */ process.env.LH_MATERI_INBOX)
		: path.join(/* turbopackIgnore: true */ PATHS.data, "materi-inbox");
}

export function materiPagesDir(): string {
	return path.join(/* turbopackIgnore: true */ path.dirname(materiIndexDir()), "materi-pages");
}

function sourcesFile(): string {
	return path.join(/* turbopackIgnore: true */ materiIndexDir(), "sources.json");
}

export function readSources(): MateriSources {
	try {
		const parsed = JSON.parse(fs.readFileSync(sourcesFile(), "utf8")) as MateriSources;
		if (parsed.version === 1 && Array.isArray(parsed.docs)) return parsed;
	} catch {
		// absent or unreadable: start empty
	}
	return { version: 1, docs: [] };
}

function writeSources(sources: MateriSources): void {
	const file = sourcesFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(sources, null, 1));
	fs.renameSync(`${file}.tmp`, file);
}

function logOutcome(outcome: IngestOutcome): void {
	const dir = materiIndexDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.appendFileSync(path.join(/* turbopackIgnore: true */ dir, "ingest-log.jsonl"), `${JSON.stringify(outcome)}\n`);
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** PDFs and Word/PowerPoint files under the inbox, recursively, as inbox-relative forward-slash paths. */
export function listInbox(root = materiInboxDir()): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(/* turbopackIgnore: true */ dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.isFile() && (/\.pdf$/i.test(e.name) || isOfficeFile(e.name))) out.push(path.relative(root, full).split(path.sep).join("/"));
		}
	};
	walk(root);
	return out.sort();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** Ingests one inbox file. Never throws: failures come back as an outcome. */
export async function ingestFile(relative: string, deps: IngestDeps = defaultDeps()): Promise<IngestOutcome> {
	const at = deps.now().toISOString();
	const matkul = matkulFromInboxPath(relative);
	const base: IngestOutcome = { at, file: relative, matkul, status: "failed" };
	if (!matkul) return { ...base, status: "skipped", note: "Put the PDF in a course folder: materi-inbox/<matkul>/file.pdf." };
	const abs = path.join(/* turbopackIgnore: true */ materiInboxDir(), ...relative.split("/"));
	const subpath = relative.split("/").slice(1).join("/");
	try {
		const data = new Uint8Array(fs.readFileSync(abs));
		const hash = sha256(data);
		// The original leaves the inbox for materi-files once it is registered.
		// A failed move keeps it where it is: the entry then points at the inbox.
		const keep = (): string => {
			try {
				return storeSourcePdf(abs, matkul, subpath, hash);
			} catch {
				return abs;
			}
		};
		const sources = readSources();
		const known = sources.docs.find((d) => d.sha256 === hash);
		if (known) {
			const same = known.duplicateOf ?? known.doc;
			const stored = sourcePdfPath(known);
			if (stored && fs.existsSync(stored) && path.resolve(stored) !== path.resolve(abs)) {
				// Same bytes are already kept: this copy only takes space.
				fs.unlinkSync(abs);
			} else {
				// The registered copy is missing (or is this very file): keep this one for every entry of the hash.
				const pdf = keep();
				writeSources({ ...sources, docs: readSources().docs.map((d) => (d.sha256 === hash ? { ...d, pdf } : d)) });
			}
			return { ...base, sha256: hash, status: "duplicate", doc: same, note: `Same content as ${same}.` };
		}

		// A password-protected PDF: the inbox sidecar, else one saved earlier for this hash.
		const sidecar = readSidecar(abs);
		const password = sidecar?.password ?? pdfPassword(hash);
		const converted = await deps.convert(data, password);
		if (converted === "password") {
			const name = path.basename(abs);
			return {
				...base,
				sha256: hash,
				note: password
					? `The password in ${sidecar ? path.basename(sidecar.file) : "the saved passwords"} does not open ${name}.`
					: `${name} is password-protected. Save the password as the first line of a text file named ${name}.password next to it; it is retried on the next scan.`,
			};
		}
		const pages = converted;
		if (!pages) return { ...base, sha256: hash, note: "The PDF could not be read (broken, or not a PDF)." };
		// Opened with a password: keep it for page display, drop the sidecar.
		if (password) {
			savePdfPassword(hash, password);
			if (sidecar) {
				try {
					fs.unlinkSync(sidecar.file);
				} catch {
					// left behind; harmless
				}
			}
		}

		const weak = pages
			.filter((p) => p.kind === "image-only" || (p.kind === "text" && needsVision(p.markdown)))
			.map((p) => p.number);
		const text = new Map<number, string>();
		for (const p of pages) if (p.kind === "text") text.set(p.number, p.markdown);

		// Near copies: the same slides under another hash (re-downloaded,
		// re-exported). Every page's text layer (short slides included) is
		// compared before any OCR is paid for; matched pages are never OCR'd.
		// A file that is nearly all old pages (a copy, or a shortened copy) is
		// not OCR'd at all; only its text pages with no old twin are indexed
		// (tested 2026-11-25: a shortened M6 deck kept its new "Tugas
		// kelompok" page), and with none it is recorded as a duplicate.
		const course = (deps.courseWords ?? courseWordSets)(matkul);
		const early = matchPages([...text].map(([page, t]) => ({ page, text: t })), course);
		const recordCopy = (of: string, note: string): IngestOutcome => {
			const entry: MateriSourceEntry = { doc: `materi-inbox/${relative}`, matkul, sha256: hash, pdf: keep(), origin: "ingested", pages: pages.length, duplicateOf: of, addedAt: at };
			writeSources({ ...sources, docs: [...readSources().docs, entry] });
			return { ...base, sha256: hash, status: "duplicate", doc: of, pages: pages.length, note };
		};
		const earlyOf = mostMatchedDoc(early.matches);
		const copyOf = earlyOf && isDuplicateDoc(early.comparable, early.matches.size) ? earlyOf : null;
		const freshInCopy = new Set(
			copyOf
				? [...text].filter(([page, t]) => !early.matches.has(page) && pageWords(t).size >= NEAR_COPY_MIN_WORDS).map(([page]) => page)
				: [],
		);
		if (copyOf && freshInCopy.size === 0) {
			return recordCopy(copyOf, `Near copy of ${copyOf}: ${early.matches.size} of ${early.comparable} text pages already indexed.`);
		}

		const ocrDir = path.join(/* turbopackIgnore: true */ materiPagesDir(), hash);
		const ocrRaw: Record<number, string> = {};
		const ocrDone: number[] = [];
		const toOcr = copyOf ? [] : weak.filter((page) => !early.matches.has(page));
		if (toOcr.length > 0) {
			fs.mkdirSync(ocrDir, { recursive: true });
			const rendered = await deps.render(abs, toOcr, password);
			await mapLimit(rendered, OCR_CONCURRENCY, async ({ page, png }) => {
				fs.writeFileSync(path.join(/* turbopackIgnore: true */ ocrDir, `${page}.png`), png);
				const raw = await deps.ocr(png, `${page}.png`);
				ocrRaw[page] = raw;
				const recognized = ocrToText(raw);
				// Keep the text layer when OCR returned less than it had.
				if (recognized.length >= (text.get(page) ?? "").trim().length) text.set(page, recognized);
				ocrDone.push(page);
			});
			fs.writeFileSync(path.join(/* turbopackIgnore: true */ ocrDir, "ocr.json"), JSON.stringify(ocrRaw));
		}

		// Pages the course already has are left out one by one: OCR'd pages are
		// compared now that they have text. A revised deck keeps its new pages.
		const late = matchPages(ocrDone.map((page) => ({ page, text: text.get(page) ?? "" })), course);
		const skipped = new Map([...early.matches, ...late.matches]);
		const kept = (page: number) => (copyOf ? freshInCopy.has(page) : !skipped.has(page));
		const leftOut = pages.map((p) => p.number).filter((n) => !kept(n));
		const doc = `materi-inbox/${relative}`;
		const keptPages = pages.filter((p) => kept(p.number));
		// Figure pages (diagrams, charts) carry the document title and section
		// heading, so a meaning search finds them by topic (core withPageContext).
		const chunks: IngestChunk[] = withPageContext(
			keptPages.flatMap((p) => chunkPage(p.number, text.get(p.number) ?? "")),
			{
				docTitle: docTitleFromFile(relative),
				pages: keptPages.map((p) => p.number),
				figurePages: new Set(keptPages.filter((p) => p.kind === "image-only" || ocrDone.includes(p.number)).map((p) => p.number)),
			},
		);
		if (chunks.length === 0) {
			const of = mostMatchedDoc(skipped);
			if (of) return { ...recordCopy(of, `Near copy of ${of}: every page with text is already indexed.`), ocrPages: ocrDone.length };
			return { ...base, sha256: hash, pages: pages.length, ocrPages: ocrDone.length, note: "No text found on any page." };
		}

		const vectors: Float32Array[] = [];
		let embedTokens = 0;
		for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
			const batch = chunks.slice(i, i + EMBED_BATCH).map(embedText);
			const res = await deps.embed(batch);
			vectors.push(...res.vectors);
			embedTokens += res.tokens;
		}
		appendToMateriIndex(
			matkul,
			chunks.map((c, i) => ({ doc, page: c.page, text: embedText(c), vector: vectors[i] as Float32Array })),
		);
		const entry: MateriSourceEntry = {
			doc,
			matkul,
			sha256: hash,
			pdf: keep(),
			origin: "ingested",
			pages: pages.length,
			ocrPages: ocrDone.sort((a, b) => a - b),
			...(copyOf ? { nearCopyOf: copyOf } : {}),
			...(copyOf || skipped.size > 0 ? { skippedPages: copyOf ? leftOut : [...skipped.keys()].sort((a, b) => a - b) } : {}),
			addedAt: at,
		};
		writeSources({ ...sources, docs: [...readSources().docs, entry] });
		return {
			...base,
			sha256: hash,
			status: "ingested",
			doc,
			pages: pages.length,
			ocrPages: ocrDone.length,
			chunks: chunks.length,
			embedTokens,
			...(copyOf
				? { note: `Near copy of ${copyOf}: not OCR'd; only ${freshInCopy.size} text page(s) with no old twin were indexed (${[...freshInCopy].join(", ")}).` }
				: skipped.size > 0
					? { note: `${skipped.size} page(s) already indexed (near copies of ${mostMatchedDoc(skipped)}) were left out.` }
					: {}),
		};
	} catch (error) {
		return { ...base, note: error instanceof Error ? error.message : String(error) };
	}
}

/** A free PDF name next to `abs`: "x.pdf", else "x (pptx).pdf". */
function pdfNameFor(abs: string): string {
	const { dir, name, ext } = path.parse(abs);
	const plain = path.join(/* turbopackIgnore: true */ dir, `${name}.pdf`);
	return fs.existsSync(plain) ? path.join(/* turbopackIgnore: true */ dir, `${name} (${ext.slice(1).toLowerCase()}).pdf`) : plain;
}

/**
 * A Word or PowerPoint file in the inbox: converted to PDF beside it (the
 * PDF is what search, OCR and page display use), the original moved to
 * materi-files next to where its PDF will live, then the PDF is ingested
 * like any other. No converter on this machine = skipped with a note; the
 * file stays in the inbox.
 */
export async function ingestOfficeFile(relative: string, deps: IngestDeps = defaultDeps()): Promise<IngestOutcome> {
	const at = deps.now().toISOString();
	const matkul = matkulFromInboxPath(relative);
	const base: IngestOutcome = { at, file: relative, matkul, status: "failed" };
	if (!matkul) return { ...base, status: "skipped", note: "Put the file in a course folder: materi-inbox/<matkul>/file.pptx." };
	const converter = (deps.office ?? officeConverter)();
	if (!converter) {
		return { ...base, status: "skipped", note: "Word/PowerPoint files need LibreOffice or Microsoft Office on this computer; save it as PDF instead." };
	}
	const root = materiInboxDir();
	const abs = path.join(/* turbopackIgnore: true */ root, ...relative.split("/"));
	const pdfAbs = pdfNameFor(abs);
	try {
		await converter.convert(abs, pdfAbs);
	} catch (error) {
		return { ...base, note: `Conversion with ${converter.name} failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	const original = path.basename(abs);
	try {
		storeSourcePdf(abs, matkul, relative.split("/").slice(1).join("/"), sha256(new Uint8Array(fs.readFileSync(abs))));
	} catch {
		// The original stays in the inbox; it is not converted again this run.
	}
	const pdfRel = path.relative(root, pdfAbs).split(path.sep).join("/");
	const outcome = await ingestFile(pdfRel, deps);
	const converted = `Converted from ${original} with ${converter.name}.`;
	return { ...outcome, convertedFrom: original, note: outcome.note ? `${converted} ${outcome.note}` : converted };
}

/** Files already handled this process (path + size + mtime), so a scan does not re-hash or re-log them. */
const handled = new Map<string, string>();
let running: Promise<IngestOutcome[]> | null = null;

/** One pass over the inbox. Concurrent calls share the pass in flight. */
export function scanInbox(deps?: IngestDeps, now: () => number = Date.now): Promise<IngestOutcome[]> {
	if (running) return running;
	running = (async () => {
		const outcomes: IngestOutcome[] = [];
		const root = materiInboxDir();
		for (const rel of listInbox(root)) {
			let stat: fs.Stats;
			try {
				stat = fs.statSync(path.join(/* turbopackIgnore: true */ root, ...rel.split("/")));
			} catch {
				continue;
			}
			if (now() - stat.mtimeMs < SETTLE_MS) continue;
			const key = `${stat.size}:${stat.mtimeMs}:${sidecarStamp(path.join(/* turbopackIgnore: true */ root, ...rel.split("/")))}`;
			if (handled.get(rel) === key) continue;
			const outcome = isOfficeFile(rel) ? await ingestOfficeFile(rel, deps) : await ingestFile(rel, deps);
			handled.set(rel, key);
			logOutcome(outcome);
			outcomes.push(outcome);
		}
		return outcomes;
	})().finally(() => {
		running = null;
	});
	return running;
}

/** Test seam: forget which files were handled. */
export function resetInboxMemory(): void {
	handled.clear();
}

let timer: NodeJS.Timeout | undefined;

/** Starts the inbox watcher (a scan now, then every 2 minutes). Idempotent. */
export function startMateriInbox(): void {
	if (timer || process.env.NODE_ENV === "test" || process.env.LH_MATERI_INBOX_OFF === "1") return;
	fs.mkdirSync(materiInboxDir(), { recursive: true });
	const tick = () => void scanInbox().catch(() => {});
	setTimeout(tick, 5_000).unref();
	timer = setInterval(tick, SCAN_INTERVAL_MS);
	timer.unref();
}

// ─── live adapters ─────────────────────────────────────────────────────────

interface OcrResponse {
	pages?: { index: number; text: string; finish_reason?: string }[];
	error?: { message?: string };
}

/** One page image through DeepSeek OCR (rich layout: blocks with boxes). */
export async function deepseekOcr(png: Buffer, name: string): Promise<string> {
	const key = keyValue("DEEPSEEK_API_KEY");
	if (!key) throw new Error("No DeepSeek API key (DEEPSEEK_API_KEY) for OCR.");
	for (let attempt = 0; attempt < 3; attempt++) {
		const form = new FormData();
		form.append("purpose", "rich_layout_recognition");
		form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), name);
		const res = await fetch(DEEPSEEK_OCR_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}` },
			body: form,
			signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
		});
		const body = (await res.text()).trim();
		let parsed: OcrResponse | undefined;
		try {
			parsed = JSON.parse(body) as OcrResponse;
		} catch {
			parsed = undefined;
		}
		const message = parsed?.error?.message ?? (res.ok ? undefined : `HTTP ${res.status}`);
		if (!message && parsed?.pages) return parsed.pages.map((p) => p.text).join("\n\n");
		const transient = res.status === 429 || res.status >= 500 || /temporarily unavailable|Internal Server Error/i.test(message ?? "");
		if (!transient || attempt === 2) throw new Error(`DeepSeek OCR failed: ${(message ?? "no result").replaceAll(key, "***")}`);
		await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
	}
	throw new Error("DeepSeek OCR failed.");
}

export function defaultDeps(): IngestDeps {
	return {
		convert: async (data, password) => {
			const result = await convertPdf(data, MAX_PAGES, { password });
			if (result.kind === "converted") return result.pages;
			return result.kind === "unreadable" && result.passwordProtected ? "password" : null;
		},
		render: (pdfPath, pages, password) => getHeadless().renderPdfPages(pdfPath, pages, { dpi: OCR_DPI, password }),
		ocr: deepseekOcr,
		embed: (texts) => embedDocuments(texts),
		now: () => new Date(),
	};
}

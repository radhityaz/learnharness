/**
 * Materi ingest core: pure helpers for turning a PDF's pages into index
 * chunks. No fs, no network (the pipeline lives in src/server/materi-ingest.ts).
 *
 * The chunking rule matches the old Belajar index (materi-indeks.ts
 * pecahHalaman), so new and migrated documents rank on equal terms:
 * one chunk per page, pages over PAGE_CHUNK_CHARS split by paragraph,
 * embedded text = title + newline + text.
 */

import { jaccard, NEAR_COPY_JACCARD, NEAR_COPY_MIN_WORDS, pageWords } from "./pdf-index.ts";

/** Characters per chunk before a page is split by paragraph (about 2k tokens). */
export const PAGE_CHUNK_CHARS = 6000;

export interface IngestChunk {
	page: number | null;
	title: string;
	text: string;
}

/** The registry of indexed documents (data/materi-index/sources.json). */
export interface MateriSourceEntry {
	/** Document id as stored in the shard rows. */
	doc: string;
	matkul: string;
	/** SHA-256 of the source file, lowercase hex; null for old documents without one. */
	sha256: string | null;
	/** Absolute path of the source PDF when known. */
	pdf: string | null;
	/** "legacy": migrated from the Belajar index; "ingested": added by the pipeline. */
	origin: "legacy" | "ingested";
	pages?: number;
	/** 1-based pages whose text came from OCR. */
	ocrPages?: number[];
	/** Set when the file is a near copy of an indexed document: nothing of it was indexed. */
	duplicateOf?: string;
	/** Set when the file is mostly a near copy of an indexed document but has text pages of its own (only those were indexed). */
	nearCopyOf?: string;
	/** 1-based pages left out: near copies of indexed pages, or (with nearCopyOf) every page but the new ones. */
	skippedPages?: number[];
	addedAt?: string;
}

/** Share of a file's comparable pages that must already exist for the whole file to count as a copy. */
export const DUPLICATE_DOC_SHARE = 0.8;
/** A file needs at least this many comparable pages before it can be judged a copy as a whole. */
export const DUPLICATE_DOC_MIN_PAGES = 3;

export interface PageMatch {
	doc: string;
	score: number;
}

/**
 * For each page with enough words, the indexed document holding its best
 * near copy (overlap at or above NEAR_COPY_JACCARD). Pages without one are
 * absent from `matches`. `existing` holds word sets of the course's chunks.
 */
export function matchPages(
	pages: readonly { page: number; text: string }[],
	existing: readonly { doc: string; words: ReadonlySet<string> }[],
): { comparable: number; matches: Map<number, PageMatch> } {
	const matches = new Map<number, PageMatch>();
	let comparable = 0;
	for (const p of pages) {
		const words = pageWords(p.text);
		if (words.size < NEAR_COPY_MIN_WORDS) continue;
		comparable++;
		let best: PageMatch | undefined;
		for (const e of existing) {
			const score = jaccard(words, e.words);
			if (score >= NEAR_COPY_JACCARD && (!best || score > best.score)) best = { doc: e.doc, score };
		}
		if (best) matches.set(p.page, best);
	}
	return { comparable, matches };
}

/** The document most matched pages point to. */
export function mostMatchedDoc(matches: ReadonlyMap<number, PageMatch>): string | null {
	const count = new Map<string, number>();
	for (const m of matches.values()) count.set(m.doc, (count.get(m.doc) ?? 0) + 1);
	let top: string | null = null;
	let n = 0;
	for (const [doc, c] of count) {
		if (c > n) {
			top = doc;
			n = c;
		}
	}
	return top;
}

/** True when the file as a whole is a copy: enough comparable pages, nearly all already indexed. */
export function isDuplicateDoc(comparable: number, matched: number): boolean {
	return comparable >= DUPLICATE_DOC_MIN_PAGES && matched / comparable >= DUPLICATE_DOC_SHARE;
}

export interface MateriSources {
	version: 1;
	docs: MateriSourceEntry[];
}

/** Splits one page into chunks (the old index's rule). Empty pages yield none. */
export function chunkPage(page: number | null, raw: string): IngestChunk[] {
	const text = raw.replace(/\n{3,}/g, "\n\n").trim();
	if (!text) return [];
	const title = /^#{1,3}\s+(.+)$/m.exec(text)?.[1]?.trim() ?? text.split("\n", 1)[0]?.slice(0, 80) ?? "";
	if (text.length <= PAGE_CHUNK_CHARS) return [{ page, title, text }];
	const out: IngestChunk[] = [];
	let buf = "";
	for (const paragraph of text.split(/\n\n/)) {
		if (buf && buf.length + paragraph.length > PAGE_CHUNK_CHARS) {
			out.push({ page, title, text: buf.trim() });
			buf = "";
		}
		buf += (buf ? "\n\n" : "") + paragraph;
	}
	if (buf.trim()) out.push({ page, title, text: buf.trim() });
	return out;
}

/** The text sent to the embedder for a chunk (same format as the migrated vectors). */
export function embedText(chunk: IngestChunk): string {
	return `${chunk.title}\n${chunk.text}`;
}

export interface OcrBlock {
	/** Block kind from the OCR model: sub_title, text, table, equation, image, image_caption, ... */
	label: string;
	/** [x1, y1, x2, y2], normalized 0-1000 to the page image. */
	box: [number, number, number, number] | null;
	text: string;
}

const REF_BOX = /<｜ref｜>([\s\S]*?)<｜\/ref｜>\s*(?:<｜box｜>\s*\[\[([^\]]*)\]\]\s*<｜\/box｜>)?/g;

/** Parses DeepSeek OCR page output into blocks with their boxes. Text before the first marker is a block without a box. */
export function parseOcrBlocks(raw: string): OcrBlock[] {
	const blocks: OcrBlock[] = [];
	const marks = [...raw.matchAll(REF_BOX)];
	const lead = raw.slice(0, marks[0]?.index ?? raw.length).trim();
	if (lead) blocks.push({ label: "text", box: null, text: lead });
	marks.forEach((m, i) => {
		const start = (m.index ?? 0) + m[0].length;
		const end = marks[i + 1]?.index ?? raw.length;
		const nums = (m[2] ?? "").split(",").map((s) => Number(s.trim()));
		const box = nums.length === 4 && nums.every(Number.isFinite) ? (nums as [number, number, number, number]) : null;
		blocks.push({ label: (m[1] ?? "").trim(), box, text: raw.slice(start, end).trim() });
	});
	return blocks;
}

/** OCR page output as plain Markdown: markers dropped, image blocks without text dropped. */
export function ocrToText(raw: string): string {
	return parseOcrBlocks(raw)
		.map((b) => b.text)
		.filter(Boolean)
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Course id from an inbox-relative path: its first folder. Null for files directly in the inbox. */
export function matkulFromInboxPath(relative: string): string | null {
	const parts = relative.split(/[\\/]/).filter(Boolean);
	if (parts.length < 2) return null;
	const first = parts[0] ?? "";
	return /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(first) ? first : null;
}

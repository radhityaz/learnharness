/**
 * The course-material search port (materi index).
 *
 * Two operations behind one seam, kept apart on purpose:
 *  - `semantic`: meaning search (Voyage embedding + rerank). Works across
 *    languages and paraphrases. Costs one embedding call and one rerank
 *    call, no chat-model call.
 *  - `exact`: literal word search (SQLite FTS5, local, free). For codes,
 *    names, symbols, and terms that must appear as written.
 * Results are never merged: in the retrieval test, merging FTS hits into the
 * semantic list lowered top-5 accuracy (27 → 23 of 32).
 *
 * Pure types only (browser-safe): the adapter lives in
 * src/server/materi-index.ts and is injected into the agent tools.
 */

import type { OcrBlock } from "./materi-ingest.ts";

export interface MateriHit {
	/** Course shard id, e.g. "matkul-mr4062-manajemen-proyek". */
	matkul: string;
	/** Source document path as indexed. */
	doc: string;
	/** 1-based page, or null when the source has no pages. */
	page: number | null;
	/** Semantic: reranker relevance (or cosine without rerank). Exact: -bm25 (higher is better). */
	score: number;
	text: string;
}

export interface MateriCourse {
	matkul: string;
	rows: number;
}

export interface MateriQueryOptions {
	matkul?: string;
	limit?: number;
	textCap?: number;
	signal?: AbortSignal;
}

export interface MateriExactResult {
	hits: MateriHit[];
	/** "all" when every term matched; "any" when the all-terms query found nothing and any-term was used. */
	match: "all" | "any";
}

/** One original page for Priming: the image (highlights drawn in) and its OCR blocks. */
export interface MateriPageView {
	/** PNG bytes. */
	png: Uint8Array;
	width: number;
	height: number;
	/** OCR blocks in reading order (block n = blocks[n - 1]); null when OCR is unavailable. */
	blocks: OcrBlock[] | null;
	/** Block numbers that were boxed. */
	highlighted: number[];
	note?: string;
}

export interface MateriSearchPort {
	courses(): MateriCourse[];
	semantic(query: string, opts?: MateriQueryOptions): Promise<MateriHit[]>;
	exact(query: string, opts?: MateriQueryOptions): Promise<MateriExactResult>;
	/** Absent when pages cannot be shown (no page renderer wired). */
	page?(doc: string, page: number, highlight?: number[]): Promise<MateriPageView>;
}

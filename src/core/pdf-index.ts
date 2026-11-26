/**
 * PDF index core: types, interfaces, constants and pure helpers.
 * No fs, no network, no node-only imports — adapters live in store/ and server/.
 */

/** Text embedding model for the materi index (owner decision 2026-11-17, after a 32-question
 *  retrieval test): voyage-4-large for text. Page-image embedding is untested and not wired. */
export const EMBED_MODEL = "voyage-4-large";
/** Reranker run over the vector candidates (not a chat LLM). */
export const RERANK_MODEL = "rerank-3";
export const EMBED_DIM = 1024;
export const EMBED_BATCH = 8;
export const PAGE_TEXT_CAP = 4000;
export const RENDER_DPI = 100;
export const SEARCH_TOP_K_DEFAULT = 8;
export const SEARCH_TOP_K_MAX = 12;
export const READ_PAGES_MAX = 6;
export const INDEX_WAIT_MS = 90_000;
export const MAX_RETRIES = 5;

export type PdfIndexStatus = "pending" | "indexing" | "ready" | "partial" | "failed";

export interface PdfManifest {
	hash: string;
	status: PdfIndexStatus;
	pageCount: number;
	paths: string[];
	embedModel: string;
	voyageTokens: number;
	imagePixels: number;
	embeddedPages?: number;
	lastError?: string;
	updatedAt: string;
}

export interface PageText {
	page: number;
	text: string;
}

export interface PageTranscript {
	page: number;
	text: string;
	model: string;
	createdAt: string;
}

export interface PageHit {
	docHash: string;
	page: number;
	score: number;
	snippet: string;
	fileName?: string;
}

export interface EmbedInput {
	page: number;
	text?: string;
	imageBase64PngDataUrl: string;
}

export interface EmbedUsage {
	textTokens: number;
	imagePixels: number;
	totalTokens: number;
}

export interface EmbedResult {
	vectors: number[][];
	usage: EmbedUsage;
}

export interface PageEmbedder {
	embedPages(inputs: EmbedInput[], signal?: AbortSignal): Promise<EmbedResult>;
	embedQuery(
		text: string,
		signal?: AbortSignal,
	): Promise<{ vector: number[]; usage: EmbedResult["usage"] }>;
}

export type PdfSearchScope = { kind: "document"; hash: string } | { kind: "library" };

export interface PdfIndex {
	ensureIndexed(
		path: string,
		opts: {
			waitMs: number;
			signal?: AbortSignal;
			onProgress?: (done: number, total: number) => void;
		},
	): Promise<{ hash: string; status: PdfIndexStatus }>;
	search(query: string, scope: PdfSearchScope, topK: number): Promise<PageHit[]>;
}

/** 1-based page batches, skipping pages already embedded. */
export function planEmbedBatches(
	pageCount: number,
	alreadyEmbedded: Set<number>,
	batch: number = EMBED_BATCH,
): number[][] {
	const size = Math.max(1, Math.floor(batch));
	const out: number[][] = [];
	let cur: number[] = [];
	for (let p = 1; p <= pageCount; p++) {
		if (alreadyEmbedded.has(p)) continue;
		cur.push(p);
		if (cur.length === size) {
			out.push(cur);
			cur = [];
		}
	}
	if (cur.length) out.push(cur);
	return out;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

/** Delay in ms before retry `attempt` (0-based). Honors Retry-After (seconds or HTTP date). */
export function backoffDelay(
	attempt: number,
	retryAfterHeader?: string | null,
	rand: () => number = Math.random,
	now: number = Date.now(),
): number {
	const h = retryAfterHeader?.trim();
	if (h) {
		if (/^\d+(\.\d+)?$/.test(h)) return Math.max(0, Math.round(Number(h) * 1000));
		const t = Date.parse(h);
		if (!Number.isNaN(t)) return Math.max(0, t - now);
	}
	const a = Math.max(0, attempt);
	const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** a);
	return Math.round(base + base * 0.25 * rand());
}

const MATH_SYMBOLS = new Set("=∑∫√±≤≥≈∂∞πθλμσ^_{}\\".split(""));

/** Whether a page's text layer is too weak to trust and vision should be used. */
export function needsVision(text: string, opts?: { hasImages?: boolean }): boolean {
	if (opts?.hasImages) return true;
	const trimmed = text.trim();
	if (trimmed.length < 200) return true;
	let nonSpace = 0;
	let math = 0;
	for (const ch of trimmed) {
		if (/\s/.test(ch)) continue;
		nonSpace++;
		if (MATH_SYMBOLS.has(ch)) math++;
	}
	return nonSpace > 0 && math / nonSpace > 0.08;
}

export function clampTopK(n?: number): number {
	if (n === undefined || !Number.isFinite(n)) return SEARCH_TOP_K_DEFAULT;
	return Math.min(SEARCH_TOP_K_MAX, Math.max(1, Math.floor(n)));
}

export function truncatePageText(text: string): string {
	return text.length > PAGE_TEXT_CAP ? text.slice(0, PAGE_TEXT_CAP) : text;
}

// ─── Materi index search (flat local shards, exact search) ─────────────────
// These constants reproduce the tested pipeline exactly: 50 nearest chunks,
// rerank the first 20, at most 2 pages per document, 10 pages returned.

export const SEARCH_DEPTH = 50;
export const RERANK_CANDIDATES = 20;
export const MAX_PAGES_PER_DOC = 2;
export const SEARCH_RESULT_LIMIT = 10;
/** Characters of chunk text sent to the reranker per candidate. */
export const RERANK_TEXT_CAP = 8000;
/** Characters of chunk text returned to the tutor per hit. */
export const HIT_TEXT_CAP = 1500;

/** One indexed chunk: a document path and its page (null when the source has no pages). */
export interface MateriRowRef {
	doc: string;
	page: number | null;
}

export interface ScoredIndex {
	index: number;
	score: number;
}

/** Scales a vector to unit length in place and returns it. A zero vector is left as is. */
export function normalizeVector(v: Float32Array): Float32Array {
	let sum = 0;
	for (const x of v) sum += x * x;
	const norm = Math.sqrt(sum);
	if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
	return v;
}

/** The k rows of a row-major matrix with the highest dot product against the query, best first. */
export function topKByDot(matrix: Float32Array, dim: number, query: Float32Array, k: number): ScoredIndex[] {
	if (dim <= 0 || query.length !== dim || matrix.length % dim !== 0) {
		throw new RangeError("vector dimensions do not match");
	}
	const rows = matrix.length / dim;
	const scored: ScoredIndex[] = new Array(rows);
	for (let r = 0; r < rows; r++) {
		const base = r * dim;
		let s = 0;
		for (let i = 0; i < dim; i++) s += (matrix[base + i] as number) * (query[i] as number);
		scored[r] = { index: r, score: s };
	}
	scored.sort((a, b) => b.score - a.score || a.index - b.index);
	return scored.slice(0, Math.max(0, Math.floor(k)));
}

// ─── Near copies (same slides under another file or hash) ──────────────────
// Word-set overlap, no model: tested 2026-11-25 on a re-downloaded M9 deck
// against its two older copies (median overlap 1.00) and the course's other
// decks (median 0.15).

/** Word-set overlap at or above which two page texts count as the same page. */
export const NEAR_COPY_JACCARD = 0.7;
/** Pages with fewer distinct words than this are too thin to compare. */
export const NEAR_COPY_MIN_WORDS = 8;

/** Distinct words (letters/digits, two or more) of a text, lowercased. */
export function pageWords(text: string): Set<string> {
	return new Set(text.toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}

/** |A ∩ B| / |A ∪ B|; 0 for two empty sets. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let shared = 0;
	for (const w of small) if (large.has(w)) shared++;
	const union = a.size + b.size - shared;
	return union === 0 ? 0 : shared / union;
}

/**
 * Drops a hit whose text is a near copy of a hit kept before it (the same
 * page indexed from two files). Order is preserved; thin texts are kept.
 */
export function dropNearCopies<T>(ordered: readonly T[], textOf: (hit: T) => string): T[] {
	const kept: Set<string>[] = [];
	const out: T[] = [];
	for (const hit of ordered) {
		const words = pageWords(textOf(hit));
		const thick = words.size >= NEAR_COPY_MIN_WORDS;
		if (thick && kept.some((k) => jaccard(words, k) >= NEAR_COPY_JACCARD)) continue;
		if (thick) kept.push(words);
		out.push(hit);
	}
	return out;
}

/** Keeps the first hit per (doc, page), at most maxPerDoc pages per document, up to limit. Order is preserved. */
export function dedupeByPage<T extends MateriRowRef>(
	ordered: readonly T[],
	maxPerDoc: number = MAX_PAGES_PER_DOC,
	limit: number = SEARCH_RESULT_LIMIT,
): T[] {
	const perDoc = new Map<string, number>();
	const seen = new Set<string>();
	const out: T[] = [];
	for (const hit of ordered) {
		const key = hit.doc + "\n" + String(hit.page);
		if (seen.has(key)) continue;
		const n = (perDoc.get(hit.doc) ?? 0) + 1;
		if (n > maxPerDoc) continue;
		perDoc.set(hit.doc, n);
		seen.add(key);
		out.push(hit);
		if (out.length >= limit) break;
	}
	return out;
}

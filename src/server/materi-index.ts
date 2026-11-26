/**
 * Materi index adapter: semantic search over the local course-material index.
 *
 * Storage is flat files, one shard per course (matkul), in
 * `<data>/materi-index/` (override: LH_MATERI_INDEX_DIR):
 *   manifest.json          { version, model, dim, rows, shards: [{ matkul, rows }] }
 *   <matkul>.f32           Float32 little-endian, rows x dim, unit length
 *   <matkul>.rows.json     [[doc, page, textOffset, textBytes], ...] in vector order
 *   <matkul>.texts.bin     chunk texts, UTF-8, concatenated
 * Search is exact (a dot product over every row), so there is no index to tune.
 *
 * One search costs no chat-model call: one Voyage embedding call for the
 * query, and one Voyage rerank call when reranking is on. The Voyage key is
 * read at call time from VOYAGE_API_KEY, else from the file named by
 * VOYAGE_KEY_FILE, else from ~/voyage.key. It is never written anywhere.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { PATHS } from "../../config.ts";
import type { MateriExactResult, MateriHit, MateriQueryOptions, MateriSearchPort } from "../core/materi.ts";
import type { VoyageUsageLine } from "../core/voyage-cost.ts";
import {
	EMBED_MODEL,
	HIT_TEXT_CAP,
	MAX_PAGES_PER_DOC,
	MAX_RETRIES,
	RERANK_CANDIDATES,
	RERANK_MODEL,
	RERANK_TEXT_CAP,
	SEARCH_DEPTH,
	SEARCH_RESULT_LIMIT,
	backoffDelay,
	dedupeByPage,
	dropNearCopies,
	normalizeVector,
	pageWords,
	topKByDot,
} from "../core/pdf-index.ts";

const VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 60_000;

type RowTuple = [doc: string, page: number | null, textOffset: number, textBytes: number];

interface Manifest {
	version: number;
	model: string;
	dim: number;
	rows: number;
	shards: { matkul: string; rows: number }[];
}

interface Shard {
	matkul: string;
	rows: RowTuple[];
	vectors: Float32Array;
	textsPath: string;
}

export type { MateriHit };

export interface MateriSearchUsage {
	embedTokens: number;
	rerankTokens: number;
}

export interface MateriSearchResult {
	/** Final pages, best first: reranked when reranking is on, else in vector order. */
	hits: MateriHit[];
	/** Pages in vector order before reranking (same de-duplication). */
	vectorHits: MateriHit[];
	usage: MateriSearchUsage;
}

export interface MateriSearchOptions {
	/** Course to search. Omit to search every course. */
	matkul?: string;
	/** Rerank the vector candidates (default true). */
	rerank?: boolean;
	/** Pages to return (default 10). */
	limit?: number;
	/** Cap on returned text per hit (default HIT_TEXT_CAP). */
	textCap?: number;
	signal?: AbortSignal;
}

export class MateriIndexError extends Error {
	constructor(
		message: string,
		readonly code: "no_index" | "no_key" | "unknown_matkul" | "voyage_failed",
	) {
		super(message);
		this.name = "MateriIndexError";
	}
}

export function materiIndexDir(): string {
	return process.env.LH_MATERI_INDEX_DIR
		? path.resolve(/* turbopackIgnore: true */ process.env.LH_MATERI_INDEX_DIR)
		: path.join(/* turbopackIgnore: true */ PATHS.data, "materi-index");
}

let cachedDir: string | undefined;
let cachedMtime: number | undefined;
let cachedManifest: Manifest | undefined;
const shardCache = new Map<string, Shard>();

/** The manifest, re-read when the directory or the file's mtime changes (an index rebuilt while running). */
function manifest(): Manifest {
	const dir = materiIndexDir();
	const file = path.join(/* turbopackIgnore: true */ dir, "manifest.json");
	let mtime: number;
	try {
		mtime = fs.statSync(file).mtimeMs;
	} catch {
		throw new MateriIndexError(`No materi index at ${dir}.`, "no_index");
	}
	if (cachedManifest && cachedDir === dir && cachedMtime === mtime) return cachedManifest;
	let parsed: Manifest;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
	} catch {
		throw new MateriIndexError(`No materi index at ${dir}.`, "no_index");
	}
	if (parsed.model !== EMBED_MODEL) {
		throw new MateriIndexError(
			`The materi index was built with ${parsed.model}, but this build searches with ${EMBED_MODEL}.`,
			"no_index",
		);
	}
	shardCache.clear();
	closeFts();
	cachedDir = dir;
	cachedMtime = mtime;
	cachedManifest = parsed;
	return parsed;
}

/** Courses in the index, with their chunk counts. */
export function materiCourses(): { matkul: string; rows: number }[] {
	return manifest().shards.map((s) => ({ matkul: s.matkul, rows: s.rows }));
}

function loadShard(matkul: string): Shard {
	const m = manifest();
	const hit = shardCache.get(matkul);
	if (hit) return hit;
	if (!m.shards.some((s) => s.matkul === matkul)) {
		throw new MateriIndexError(`Unknown course "${matkul}".`, "unknown_matkul");
	}
	const dir = materiIndexDir();
	const buf = fs.readFileSync(path.join(/* turbopackIgnore: true */ dir, `${matkul}.f32`));
	// Copy into an aligned buffer: a Float32Array view needs a byte offset divisible by 4.
	const vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
	const rows = JSON.parse(
		fs.readFileSync(path.join(/* turbopackIgnore: true */ dir, `${matkul}.rows.json`), "utf8"),
	) as RowTuple[];
	// Rows define the shard: a vector file longer than rows x dim is a
	// half-finished append (vectors are written before rows) and its tail is
	// ignored; a shorter one is damage.
	if (vectors.length < rows.length * m.dim) {
		throw new MateriIndexError(`The materi index shard for "${matkul}" is damaged.`, "no_index");
	}
	const shard: Shard = {
		matkul,
		rows,
		vectors: vectors.length === rows.length * m.dim ? vectors : vectors.subarray(0, rows.length * m.dim),
		textsPath: path.join(/* turbopackIgnore: true */ dir, `${matkul}.texts.bin`),
	};
	shardCache.set(matkul, shard);
	return shard;
}

function readText(shard: Shard, row: number): string {
	const ref = shard.rows[row];
	if (!ref || ref[3] === 0) return "";
	const [, , offset, bytes] = ref;
	const fd = fs.openSync(shard.textsPath, "r");
	try {
		const buf = Buffer.allocUnsafe(bytes);
		fs.readSync(fd, buf, 0, bytes, offset);
		return buf.toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/** A chunk's text without its first line (the document title, which differs between copies). */
function chunkBody(text: string): string {
	const nl = text.indexOf("\n");
	return nl === -1 ? text : text.slice(nl + 1);
}

/**
 * Word sets of every chunk in a course, for near-copy checks at ingest.
 * Empty when the course (or the whole index) does not exist yet.
 */
export function courseWordSets(matkul: string): { doc: string; words: Set<string> }[] {
	let shard: Shard;
	try {
		shard = loadShard(matkul);
	} catch (error) {
		if (error instanceof MateriIndexError) return [];
		throw error;
	}
	const all = fs.readFileSync(shard.textsPath);
	return shard.rows.map(([doc, , offset, bytes]) => ({
		doc,
		words: pageWords(chunkBody(all.subarray(offset, offset + bytes).toString("utf8"))),
	}));
}

function voyageKey(): string {
	const env = process.env.VOYAGE_API_KEY?.trim();
	if (env) return env;
	const file = process.env.VOYAGE_KEY_FILE?.trim() || path.join(os.homedir(), "voyage.key");
	try {
		const key = fs.readFileSync(file, "utf8").trim();
		if (key) return key;
	} catch {
		// fall through to the error below
	}
	throw new MateriIndexError("No Voyage API key. Set VOYAGE_API_KEY, or put the key in ~/voyage.key.", "no_key");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

/** The Voyage spend ledger: one JSON line per successful call. */
export function voyageUsagePath(): string {
	return path.join(materiIndexDir(), "voyage-usage.jsonl");
}

/** Append {at, model, tokens} for one billed call. Never throws: a ledger
 *  that cannot be written must not fail a search or an ingest. */
function recordVoyageUsage(body: unknown, response: unknown): void {
	try {
		const model = (body as { model?: unknown })?.model;
		const tokens = (response as { usage?: { total_tokens?: unknown } })?.usage?.total_tokens;
		if (typeof model !== "string" || typeof tokens !== "number") return;
		fs.mkdirSync(materiIndexDir(), { recursive: true });
		fs.appendFileSync(voyageUsagePath(), `${JSON.stringify({ at: new Date().toISOString(), model, tokens })}\n`);
	} catch {
		// best effort
	}
}

/** Every ledger line; torn lines are skipped. */
export function readVoyageUsage(): VoyageUsageLine[] {
	let raw: string;
	try {
		raw = fs.readFileSync(voyageUsagePath(), "utf8");
	} catch {
		return [];
	}
	const out: VoyageUsageLine[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as VoyageUsageLine);
		} catch {
			// skipped
		}
	}
	return out;
}

async function voyagePost<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const key = voyageKey();
	let last = "";
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		signal?.throwIfAborted();
		let retryAfter: string | null = null;
		try {
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const res = await fetch(url, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (res.ok) {
				const json = (await res.json()) as T;
				recordVoyageUsage(body, json);
				return json;
			}
			const detail = (await res.text()).slice(0, 200).replaceAll(key, "***");
			last = `HTTP ${res.status}: ${detail}`;
			if (!RETRY_STATUS.has(res.status)) break;
			retryAfter = res.headers.get("retry-after");
		} catch (error) {
			if (signal?.aborted) throw error;
			last = error instanceof Error ? error.name : "network error";
		}
		if (attempt < MAX_RETRIES) await sleep(backoffDelay(attempt, retryAfter), signal);
	}
	throw new MateriIndexError(`Voyage request failed (${last}).`, "voyage_failed");
}

interface VoyageEmbedResponse {
	data: { embedding: number[]; index: number }[];
	usage: { total_tokens: number };
}

interface VoyageRerankResponse {
	data: { index: number; relevance_score: number }[];
	usage: { total_tokens: number };
}

interface Candidate {
	shard: Shard;
	row: number;
	score: number;
	doc: string;
	page: number | null;
}

function toHit(c: Candidate, score: number, textCap: number, text?: string): MateriHit {
	const full = text ?? readText(c.shard, c.row);
	return { matkul: c.shard.matkul, doc: c.doc, page: c.page, score, text: full.slice(0, textCap) };
}

/**
 * Semantic search over the materi index. The query is embedded as written
 * (no rewriting), the nearest chunks are found by exact search, the first
 * RERANK_CANDIDATES are reranked, and pages are de-duplicated.
 */
export async function searchMateri(query: string, opts: MateriSearchOptions = {}): Promise<MateriSearchResult> {
	const q = query.trim();
	if (!q) return { hits: [], vectorHits: [], usage: { embedTokens: 0, rerankTokens: 0 } };
	const m = manifest();
	const limit = Math.max(1, Math.min(SEARCH_RESULT_LIMIT, Math.floor(opts.limit ?? SEARCH_RESULT_LIMIT)));
	const textCap = opts.textCap ?? HIT_TEXT_CAP;
	const shards = opts.matkul ? [loadShard(opts.matkul)] : m.shards.map((s) => loadShard(s.matkul));

	const embedded = await voyagePost<VoyageEmbedResponse>(
		VOYAGE_EMBED_URL,
		{ input: [q], model: EMBED_MODEL, input_type: "query" },
		opts.signal,
	);
	const vector = normalizeVector(Float32Array.from(embedded.data[0]?.embedding ?? []));
	if (vector.length !== m.dim) {
		throw new MateriIndexError("Voyage returned a vector of an unexpected size.", "voyage_failed");
	}

	const nearest: Candidate[] = [];
	for (const shard of shards) {
		for (const s of topKByDot(shard.vectors, m.dim, vector, SEARCH_DEPTH)) {
			const ref = shard.rows[s.index];
			if (ref) nearest.push({ shard, row: s.index, score: s.score, doc: ref[0], page: ref[1] });
		}
	}
	nearest.sort((a, b) => b.score - a.score);
	// The same page indexed from two files (a re-downloaded deck) keeps only
	// its best-ranked copy, before the reranker sees it.
	const top = dropNearCopies(
		nearest.slice(0, SEARCH_DEPTH).map((c) => ({ ...c, text: readText(c.shard, c.row) })),
		(c) => chunkBody(c.text),
	);

	const usage: MateriSearchUsage = { embedTokens: embedded.usage?.total_tokens ?? 0, rerankTokens: 0 };
	const vectorHits = dedupeByPage(top, MAX_PAGES_PER_DOC, limit).map((c) => toHit(c, c.score, textCap, c.text));
	if (opts.rerank === false || top.length === 0) return { hits: vectorHits, vectorHits, usage };

	const candidates = top.slice(0, RERANK_CANDIDATES);
	const texts = candidates.map((c) => c.text);
	const reranked = await voyagePost<VoyageRerankResponse>(
		VOYAGE_RERANK_URL,
		{ query: q, documents: texts.map((t) => t.slice(0, RERANK_TEXT_CAP) || "(kosong)"), model: RERANK_MODEL },
		opts.signal,
	);
	usage.rerankTokens = reranked.usage?.total_tokens ?? 0;
	const order = [...reranked.data].sort((a, b) => b.relevance_score - a.relevance_score);
	const ranked: (Candidate & { text: string })[] = [];
	for (const r of order) {
		const candidate = candidates[r.index];
		if (candidate) ranked.push({ ...candidate, score: r.relevance_score, text: texts[r.index] ?? "" });
	}
	const hits = dedupeByPage(ranked, MAX_PAGES_PER_DOC, limit).map((c) => toHit(c, c.score, textCap, c.text));
	return { hits, vectorHits, usage };
}

// ─── Exact word search (SQLite FTS5, local) ────────────────────────────────
// A separate tool, never merged into the semantic list. The FTS file is
// built from the same shards (buildMateriFts, scripts/materi-fts-build.ts)
// and stamped with the manifest it was built from; a stale file is refused
// rather than searched.

const FTS_FILE = "fts.sqlite";
/** Rows fetched from FTS before page de-duplication. */
const EXACT_DEPTH = 60;
/** Tokens of context per side in an exact-search snippet. */
const SNIPPET_TOKENS = 32;

function ftsStamp(m: Manifest): string {
	return `${m.version}|${m.model}|${m.rows}|${m.shards.map((s) => `${s.matkul}:${s.rows}`).join(",")}`;
}

export function materiFtsPath(): string {
	return path.join(/* turbopackIgnore: true */ materiIndexDir(), FTS_FILE);
}

/** Builds (or rebuilds) the FTS5 file from the shards. Returns the number of chunks indexed. */
export function buildMateriFts(): number {
	const m = manifest();
	const file = materiFtsPath();
	const tmp = `${file}.tmp`;
	fs.rmSync(tmp, { force: true });
	const db = new DatabaseSync(tmp);
	let count = 0;
	try {
		db.exec(`
			CREATE VIRTUAL TABLE chunks USING fts5(
				matkul UNINDEXED, doc UNINDEXED, page UNINDEXED, text,
				tokenize = 'unicode61 remove_diacritics 2'
			);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
		const insert = db.prepare("INSERT INTO chunks (matkul, doc, page, text) VALUES (?, ?, ?, ?)");
		db.exec("BEGIN");
		for (const { matkul } of m.shards) {
			const shard = loadShard(matkul);
			const texts = fs.readFileSync(shard.textsPath);
			for (const [doc, page, offset, bytes] of shard.rows) {
				insert.run(matkul, doc, page, texts.toString("utf8", offset, offset + bytes));
				count++;
			}
		}
		db.prepare("INSERT INTO meta (key, value) VALUES ('stamp', ?)").run(ftsStamp(m));
		db.exec("COMMIT");
		db.exec("INSERT INTO chunks (chunks) VALUES ('optimize')");
	} finally {
		db.close();
	}
	closeFts();
	fs.renameSync(tmp, file);
	return count;
}

let ftsDb: DatabaseSync | undefined;
let ftsDbPath: string | undefined;

/** Releases the cached FTS handle (tests: lets the index dir be deleted). */
export function closeFts(): void {
	ftsDb?.close();
	ftsDb = undefined;
	ftsDbPath = undefined;
}

function openFts(): DatabaseSync {
	const m = manifest();
	const file = materiFtsPath();
	if (ftsDb && ftsDbPath === file) return ftsDb;
	closeFts();
	if (!fs.existsSync(file)) {
		throw new MateriIndexError("The exact-search index is not built. Run scripts/materi-fts-build.ts.", "no_index");
	}
	const db = new DatabaseSync(file, { readOnly: true });
	const row = db.prepare("SELECT value FROM meta WHERE key = 'stamp'").get() as { value?: string } | undefined;
	if (row?.value !== ftsStamp(m)) {
		db.close();
		throw new MateriIndexError(
			"The exact-search index is out of date. Run scripts/materi-fts-build.ts.",
			"no_index",
		);
	}
	ftsDb = db;
	ftsDbPath = file;
	return db;
}

/**
 * Splits a query into FTS5 terms. "Quoted phrases" stay phrases; other
 * words become single terms. Every term is quoted, so FTS5 operators and
 * punctuation in the query are matched literally, never interpreted.
 * Terms with no letter or digit are dropped.
 */
export function ftsTerms(query: string): string[] {
	const terms: string[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	for (const match of query.matchAll(re)) {
		const raw = (match[1] ?? match[2] ?? "").trim();
		if (!raw || !/[\p{L}\p{N}]/u.test(raw)) continue;
		terms.push(`"${raw.replaceAll('"', '""')}"`);
	}
	return terms;
}

interface FtsRow {
	matkul: string;
	doc: string;
	page: number | null;
	snip: string;
	rank: number;
}

/** Literal word search over the materi index. Tries all terms first, then any term. */
export function exactSearchMateri(query: string, opts: MateriQueryOptions = {}): MateriExactResult {
	const terms = ftsTerms(query);
	if (terms.length === 0) return { hits: [], match: "all" };
	if (opts.matkul && !manifest().shards.some((s) => s.matkul === opts.matkul)) {
		throw new MateriIndexError(`Unknown course "${opts.matkul}".`, "unknown_matkul");
	}
	const db = openFts();
	const limit = Math.max(1, Math.min(SEARCH_RESULT_LIMIT, Math.floor(opts.limit ?? SEARCH_RESULT_LIMIT)));
	const textCap = opts.textCap ?? HIT_TEXT_CAP;
	const sql =
		`SELECT matkul, doc, page, snippet(chunks, 3, '[', ']', ' … ', ${SNIPPET_TOKENS}) AS snip, bm25(chunks) AS rank ` +
		`FROM chunks WHERE chunks MATCH ?${opts.matkul ? " AND matkul = ?" : ""} ORDER BY rank LIMIT ${EXACT_DEPTH}`;
	const stmt = db.prepare(sql);
	const run = (expr: string): FtsRow[] =>
		(opts.matkul ? stmt.all(expr, opts.matkul) : stmt.all(expr)) as unknown as FtsRow[];
	let match: "all" | "any" = "all";
	let rows = run(terms.join(" AND "));
	if (rows.length === 0 && terms.length > 1) {
		match = "any";
		rows = run(terms.join(" OR "));
	}
	const hits = dedupeByPage(
		dropNearCopies(
			rows.map((r) => ({ matkul: r.matkul, doc: r.doc, page: r.page, score: -r.rank, text: r.snip.slice(0, textCap) })),
			(h) => h.text,
		),
		MAX_PAGES_PER_DOC,
		limit,
	);
	return { hits, match };
}

/** The injected port for the agent tools; null when no index is installed. */
export function materiSearchPort(): MateriSearchPort | null {
	try {
		manifest();
	} catch {
		return null;
	}
	return {
		courses: materiCourses,
		semantic: async (query, opts = {}) => (await searchMateri(query, opts)).hits,
		exact: async (query, opts = {}) => exactSearchMateri(query, opts),
		page: async (doc, page, highlight) => (await import("./materi-pages.ts")).materiPage(doc, page, highlight),
	};
}

// ─── Appending documents (the ingest pipeline's writer) ────────────────────

/** Voyage document embeddings, normalized, in input order. */
export async function embedDocuments(
	texts: string[],
	signal?: AbortSignal,
): Promise<{ vectors: Float32Array[]; tokens: number }> {
	if (texts.length === 0) return { vectors: [], tokens: 0 };
	const res = await voyagePost<VoyageEmbedResponse>(
		VOYAGE_EMBED_URL,
		{ input: texts.map((t) => t || "(kosong)"), model: EMBED_MODEL, input_type: "document" },
		signal,
	);
	const vectors: Float32Array[] = new Array(texts.length);
	for (const d of res.data) vectors[d.index] = normalizeVector(Float32Array.from(d.embedding));
	if (vectors.some((v) => !v)) throw new MateriIndexError("Voyage returned fewer vectors than inputs.", "voyage_failed");
	return { vectors, tokens: res.usage?.total_tokens ?? 0 };
}

export interface AppendRow {
	doc: string;
	page: number | null;
	/** The embedded text (title + newline + text), stored as the chunk text. */
	text: string;
	vector: Float32Array;
}

function writeAtomic(file: string, data: string | Uint8Array): void {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

/**
 * Adds chunks to a course shard (creating the shard and, when needed, the
 * index). Write order keeps every intermediate state readable: text bytes
 * are appended, then the longer vector file and the rows replace the old
 * ones, then FTS gets the rows, and the manifest is written last. Readers
 * keep their cached copy until the manifest changes.
 */
export function appendToMateriIndex(matkul: string, rows: AppendRow[], meta: { dim?: number } = {}): void {
	if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(matkul)) throw new MateriIndexError(`Bad course id "${matkul}".`, "unknown_matkul");
	if (rows.length === 0) return;
	const dir = materiIndexDir();
	fs.mkdirSync(dir, { recursive: true });
	const manifestFile = path.join(/* turbopackIgnore: true */ dir, "manifest.json");
	let m: Manifest & Record<string, unknown>;
	try {
		m = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest & Record<string, unknown>;
	} catch {
		m = { version: 1, model: EMBED_MODEL, dim: meta.dim ?? rows[0]?.vector.length ?? 0, rows: 0, shards: [], normalized: true };
	}
	if (m.model !== EMBED_MODEL) throw new MateriIndexError(`Index model ${m.model} is not ${EMBED_MODEL}.`, "no_index");
	if (rows.some((r) => r.vector.length !== m.dim)) throw new MateriIndexError("Vector size does not match the index.", "voyage_failed");

	const base = path.join(/* turbopackIgnore: true */ dir, matkul);
	const textsFile = `${base}.texts.bin`;
	const rowsFile = `${base}.rows.json`;
	const vecFile = `${base}.f32`;
	const oldRows: RowTuple[] = fs.existsSync(rowsFile) ? (JSON.parse(fs.readFileSync(rowsFile, "utf8")) as RowTuple[]) : [];
	const oldVec = fs.existsSync(vecFile) ? fs.readFileSync(vecFile).subarray(0, oldRows.length * m.dim * 4) : Buffer.alloc(0);
	let offset = fs.existsSync(textsFile) ? fs.statSync(textsFile).size : 0;

	const newRows: RowTuple[] = [];
	const textBufs: Buffer[] = [];
	const vecBuf = Buffer.alloc(rows.length * m.dim * 4);
	rows.forEach((r, i) => {
		const b = Buffer.from(r.text, "utf8");
		newRows.push([r.doc, r.page, offset, b.length]);
		textBufs.push(b);
		offset += b.length;
		Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength).copy(vecBuf, i * m.dim * 4);
	});
	fs.appendFileSync(textsFile, Buffer.concat(textBufs));
	writeAtomic(vecFile, Buffer.concat([oldVec, vecBuf]));
	const allRows = [...oldRows, ...newRows];
	writeAtomic(rowsFile, JSON.stringify(allRows));

	const shards = m.shards.filter((s) => s.matkul !== matkul);
	shards.push({ ...(m.shards.find((s) => s.matkul === matkul) ?? {}), matkul, rows: allRows.length, textBytes: offset } as Manifest["shards"][number]);
	shards.sort((a, b) => a.matkul.localeCompare(b.matkul));
	const next: Manifest & Record<string, unknown> = {
		...m,
		rows: shards.reduce((n, s) => n + s.rows, 0),
		shards,
		updatedAt: new Date().toISOString(),
	};

	const ftsFile = path.join(/* turbopackIgnore: true */ dir, FTS_FILE);
	if (fs.existsSync(ftsFile)) {
		closeFts();
		const db = new DatabaseSync(ftsFile);
		try {
			db.exec("BEGIN");
			// Only a current FTS file is extended; a stale one stays stale
			// (refused at search time) until it is rebuilt.
			const stamp = db.prepare("SELECT value FROM meta WHERE key = 'stamp'").get() as { value?: string } | undefined;
			if (stamp?.value === ftsStamp(m)) {
				const insert = db.prepare("INSERT INTO chunks (matkul, doc, page, text) VALUES (?, ?, ?, ?)");
				for (const r of rows) insert.run(matkul, r.doc, r.page, r.text);
				db.prepare("UPDATE meta SET value = ? WHERE key = 'stamp'").run(ftsStamp(next));
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		} finally {
			db.close();
		}
	}
	writeAtomic(manifestFile, JSON.stringify(next, null, 1));
	cachedManifest = undefined;
	shardCache.clear();
}

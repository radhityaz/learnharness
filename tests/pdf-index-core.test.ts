import assert from "node:assert/strict";
import test from "node:test";

import {
	PAGE_TEXT_CAP,
	SEARCH_TOP_K_DEFAULT,
	SEARCH_TOP_K_MAX,
	backoffDelay,
	clampTopK,
	dedupeByPage,
	dropNearCopies,
	jaccard,
	needsVision,
	pageWords,
	normalizeVector,
	planEmbedBatches,
	topKByDot,
	truncatePageText,
} from "../src/core/pdf-index.ts";

test("near copies: word overlap drops a re-indexed page, keeps different and thin pages", () => {
	assert.deepEqual([...pageWords("K-Means: the SSE, the sse! a 2")].sort(), ["means", "sse", "the"]);
	assert.equal(jaccard(new Set(), new Set()), 0);
	assert.equal(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);

	const page = "Limitations of K-means: differing sizes, differing density and non-globular shapes of clusters";
	const hits = [
		{ id: 1, text: page },
		{ id: 2, text: `${page}.` }, // the same page from another file
		{ id: 3, text: "Hierarchical clustering builds a dendrogram by merging the closest pair of clusters" },
		{ id: 4, text: "K-means" }, // too thin to judge
		{ id: 5, text: "K-means" },
	];
	assert.deepEqual(dropNearCopies(hits, (h) => h.text).map((h) => h.id), [1, 3, 4, 5]);
});

test("planEmbedBatches batches 1-based pages and skips embedded", () => {
	assert.deepEqual(planEmbedBatches(0, new Set()), []);
	assert.deepEqual(planEmbedBatches(3, new Set()), [[1, 2, 3]]);
	assert.deepEqual(planEmbedBatches(10, new Set()), [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10]]);
	assert.deepEqual(planEmbedBatches(5, new Set([2, 3]), 2), [[1, 4], [5]]);
	assert.deepEqual(planEmbedBatches(3, new Set([1, 2, 3])), []);
	assert.deepEqual(planEmbedBatches(3, new Set(), 0), [[1], [2], [3]]);
});

test("backoffDelay is exponential, capped, with bounded jitter", () => {
	assert.equal(backoffDelay(0, null, () => 0), 1000);
	assert.equal(backoffDelay(2, undefined, () => 0), 4000);
	assert.equal(backoffDelay(10, null, () => 0), 30_000);
	assert.equal(backoffDelay(0, null, () => 1), 1250);
	assert.equal(backoffDelay(10, null, () => 1), 37_500);
});

test("backoffDelay honors Retry-After seconds and HTTP date", () => {
	assert.equal(backoffDelay(0, "7"), 7000);
	assert.equal(backoffDelay(3, "0"), 0);
	const now = Date.parse("2026-01-01T00:00:00Z");
	assert.equal(backoffDelay(0, "Thu, 01 Jan 2026 00:00:05 GMT", () => 0, now), 5000);
	assert.equal(backoffDelay(0, "Wed, 31 Dec 2025 00:00:00 GMT", () => 0, now), 0);
	// garbage falls back to exponential
	assert.equal(backoffDelay(1, "soon", () => 0), 2000);
	assert.equal(backoffDelay(1, "  ", () => 0), 2000);
});

test("needsVision heuristics", () => {
	const prose = "The quick brown fox jumps over the lazy dog. ".repeat(10);
	assert.equal(needsVision(prose), false);
	assert.equal(needsVision("short"), true);
	assert.equal(needsVision("   " + "a".repeat(150) + "   "), true);
	assert.equal(needsVision(prose, { hasImages: true }), true);
	assert.equal(needsVision(prose + "x = y^2 + z_1"), false);
	const formulas = "∑_{i=1}^{n} x_i = ∫ f(x) dx ≈ √π ".repeat(10);
	assert.equal(needsVision(formulas), true);
	assert.equal(needsVision(""), true);
});

test("clampTopK", () => {
	assert.equal(clampTopK(), SEARCH_TOP_K_DEFAULT);
	assert.equal(clampTopK(NaN), SEARCH_TOP_K_DEFAULT);
	assert.equal(clampTopK(0), 1);
	assert.equal(clampTopK(-5), 1);
	assert.equal(clampTopK(5.9), 5);
	assert.equal(clampTopK(100), SEARCH_TOP_K_MAX);
});

test("truncatePageText", () => {
	assert.equal(truncatePageText("abc"), "abc");
	const exact = "x".repeat(PAGE_TEXT_CAP);
	assert.equal(truncatePageText(exact), exact);
	assert.equal(truncatePageText(exact + "y").length, PAGE_TEXT_CAP);
});

test("normalizeVector scales to unit length and leaves zero vectors alone", () => {
	const v = normalizeVector(Float32Array.from([3, 4]));
	assert.ok(Math.abs(v[0]! - 0.6) < 1e-6);
	assert.ok(Math.abs(v[1]! - 0.8) < 1e-6);
	assert.deepEqual(Array.from(normalizeVector(Float32Array.from([0, 0]))), [0, 0]);
});

test("topKByDot returns the best rows first and rejects mismatched sizes", () => {
	const matrix = Float32Array.from([1, 0, 0, 1, 0.6, 0.8, -1, 0]);
	const query = Float32Array.from([1, 0]);
	assert.deepEqual(
		topKByDot(matrix, 2, query, 3).map((x) => x.index),
		[0, 2, 1],
	);
	assert.deepEqual(topKByDot(matrix, 2, query, 0), []);
	assert.equal(topKByDot(matrix, 2, query, 99).length, 4);
	// ties keep the earlier row first
	const tied = Float32Array.from([1, 0, 1, 0]);
	assert.deepEqual(
		topKByDot(tied, 2, query, 2).map((x) => x.index),
		[0, 1],
	);
	assert.throws(() => topKByDot(matrix, 3, query, 1), RangeError);
	assert.throws(() => topKByDot(matrix, 2, Float32Array.from([1, 0, 0]), 1), RangeError);
});

test("dedupeByPage keeps one hit per page, caps pages per document, and keeps order", () => {
	const hits = [
		{ doc: "a.pdf", page: 3 },
		{ doc: "a.pdf", page: 3 },
		{ doc: "a.pdf", page: 4 },
		{ doc: "a.pdf", page: 5 },
		{ doc: "b.pdf", page: 1 },
		{ doc: "c.pdf", page: null },
		{ doc: "c.pdf", page: null },
	];
	assert.deepEqual(dedupeByPage(hits), [
		{ doc: "a.pdf", page: 3 },
		{ doc: "a.pdf", page: 4 },
		{ doc: "b.pdf", page: 1 },
		{ doc: "c.pdf", page: null },
	]);
	assert.deepEqual(dedupeByPage(hits, 1, 2), [
		{ doc: "a.pdf", page: 3 },
		{ doc: "b.pdf", page: 1 },
	]);
	assert.deepEqual(dedupeByPage([]), []);
});

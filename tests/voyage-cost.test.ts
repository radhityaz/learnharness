/**
 * Voyage spend: the pure fold over the ledger (list price, free allowance,
 * unpriced models) and the Settings line built from it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDollars, voyageSpend } from "../src/core/voyage-cost.ts";
import { voyageLine } from "../components/settings/materials-section.tsx";

describe("voyageSpend", () => {
	it("an empty ledger is zero, with no start date", () => {
		const s = voyageSpend([]);
		assert.equal(s.calls, 0);
		assert.equal(s.listDollars, 0);
		assert.equal(s.since, null);
	});
	it("sums tokens per model at list price; inside the free allowance nothing is billed", () => {
		const s = voyageSpend([
			{ at: "2026-11-26T02:00:00Z", model: "voyage-4-large", tokens: 1_000_000 },
			{ at: "2026-11-26T01:00:00Z", model: "voyage-4-large", tokens: 500_000 },
			{ at: "2026-11-26T03:00:00Z", model: "rerank-3", tokens: 2_000_000 },
		]);
		assert.equal(s.calls, 3);
		assert.equal(s.tokens, 3_500_000);
		assert.equal(s.since, "2026-11-26T01:00:00Z");
		assert.ok(Math.abs(s.listDollars - (1.5 * 0.12 + 2 * 0.05)) < 1e-9);
		assert.equal(s.billedDollars, 0);
		assert.equal(s.models[0]?.model, "rerank-3", "largest first");
	});
	it("bills only the tokens above the free allowance", () => {
		const s = voyageSpend([{ at: "x", model: "voyage-4-large", tokens: 201_000_000 }]);
		assert.ok(Math.abs(s.billedDollars - 0.12) < 1e-9);
		assert.equal(s.models[0]?.freeLeft, 0);
	});
	it("a model missing from the price table is reported, never priced as zero silently", () => {
		const s = voyageSpend([{ at: "x", model: "voyage-9", tokens: 10 }]);
		assert.deepEqual(s.unpriced, ["voyage-9"]);
		assert.equal(s.models[0]?.listDollars, null);
		assert.match(voyageLine(s.models[0]!), /unpriced/);
	});
	it("torn lines are ignored", () => {
		const s = voyageSpend([{ at: "x", model: "rerank-3", tokens: Number.NaN }, null as never]);
		assert.equal(s.calls, 0);
	});
});

describe("formatting", () => {
	it("small spends keep significant digits", () => {
		assert.equal(formatDollars(0), "$0");
		assert.equal(formatDollars(0.00041234), "$0.00041");
		assert.equal(formatDollars(1.234), "$1.23");
	});
	it("the Settings line names the model, tokens and the bill", () => {
		const s = voyageSpend([{ at: "x", model: "voyage-4-large", tokens: 12_345 }]);
		assert.equal(voyageLine(s.models[0]!), "voyage-4-large · 12,345 tokens · $0.0015 at list price, within the free allowance");
	});
});

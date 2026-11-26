/**
 * Voyage spend for the course-material index (embeddings for search and
 * ingest, reranking for search). Voyage bills by tokens; every successful
 * call appends one ledger line {at, model, tokens}. This fold turns the
 * ledger into totals for Settings → Course materials.
 *
 * Prices and free allowances: docs.voyageai.com/docs/pricing, checked
 * 2026-11-26. List price is what the tokens would cost; each model has a
 * one-time per-account free allowance, so the bill is the part above it.
 * The ledger only knows calls made since it was added, so the "billed"
 * figure is a lower bound when earlier usage exists.
 *
 * Client-safe: pure types and math, no node imports.
 */

/** USD per 1M tokens and the per-account free allowance, by model. */
export const VOYAGE_PRICES: Record<string, { perMillion: number; freeTokens: number }> = {
	"voyage-4-large": { perMillion: 0.12, freeTokens: 200_000_000 },
	"voyage-4": { perMillion: 0.06, freeTokens: 200_000_000 },
	"voyage-4-lite": { perMillion: 0.02, freeTokens: 200_000_000 },
	"rerank-3": { perMillion: 0.05, freeTokens: 200_000_000 },
	"rerank-3-lite": { perMillion: 0.02, freeTokens: 200_000_000 },
	"rerank-2.5": { perMillion: 0.05, freeTokens: 0 },
	"rerank-2.5-lite": { perMillion: 0.02, freeTokens: 0 },
};

export interface VoyageUsageLine {
	at: string;
	model: string;
	tokens: number;
}

export interface VoyageModelSpend {
	model: string;
	calls: number;
	tokens: number;
	/** Tokens × list price; null for a model missing from the price table. */
	listDollars: number | null;
	/** Free allowance left (0 when the model has none or it is used up); null when unpriced. */
	freeLeft: number | null;
	/** List price of the tokens above the free allowance; null when unpriced. */
	billedDollars: number | null;
}

export interface VoyageSpend {
	/** Oldest ledger line, ISO; null for an empty ledger. */
	since: string | null;
	calls: number;
	tokens: number;
	listDollars: number;
	billedDollars: number;
	/** Models missing from the price table (their dollars are not in the totals). */
	unpriced: string[];
	models: VoyageModelSpend[];
}

/** Fold ledger lines into totals. Pure. */
export function voyageSpend(lines: readonly VoyageUsageLine[]): VoyageSpend {
	const byModel = new Map<string, { calls: number; tokens: number }>();
	let since: string | null = null;
	for (const line of lines) {
		if (!line || typeof line.model !== "string" || !Number.isFinite(line.tokens)) continue;
		const m = byModel.get(line.model) ?? { calls: 0, tokens: 0 };
		m.calls++;
		m.tokens += Math.max(0, line.tokens);
		byModel.set(line.model, m);
		if (typeof line.at === "string" && (since === null || line.at < since)) since = line.at;
	}
	const models: VoyageModelSpend[] = [...byModel.entries()]
		.map(([model, { calls, tokens }]) => {
			const price = VOYAGE_PRICES[model];
			if (!price) return { model, calls, tokens, listDollars: null, freeLeft: null, billedDollars: null };
			const over = Math.max(0, tokens - price.freeTokens);
			return {
				model,
				calls,
				tokens,
				listDollars: (tokens / 1e6) * price.perMillion,
				freeLeft: Math.max(0, price.freeTokens - tokens),
				billedDollars: (over / 1e6) * price.perMillion,
			};
		})
		.sort((a, b) => b.tokens - a.tokens);
	return {
		since,
		calls: models.reduce((n, m) => n + m.calls, 0),
		tokens: models.reduce((n, m) => n + m.tokens, 0),
		listDollars: models.reduce((n, m) => n + (m.listDollars ?? 0), 0),
		billedDollars: models.reduce((n, m) => n + (m.billedDollars ?? 0), 0),
		unpriced: models.filter((m) => m.listDollars === null).map((m) => m.model),
		models,
	};
}

/** "$0.00041", "$1.23": small spends keep enough digits to stay non-zero. */
export function formatDollars(d: number): string {
	if (d === 0) return "$0";
	if (d < 0.01) return `$${d.toPrecision(2)}`;
	return `$${d.toFixed(2)}`;
}

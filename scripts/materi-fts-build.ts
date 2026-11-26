/**
 * Builds the exact-search (FTS5) file for the materi index.
 * Usage: npx tsx scripts/materi-fts-build.ts
 * Reads data/materi-index (or LH_MATERI_INDEX_DIR); makes no network call.
 */
import { buildMateriFts, materiFtsPath } from "../src/server/materi-index.ts";

const started = Date.now();
const count = buildMateriFts();
console.log(`FTS5: ${count} chunks → ${materiFtsPath()} (${((Date.now() - started) / 1000).toFixed(1)} s)`);

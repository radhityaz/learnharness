/**
 * Gate for the materi index: runs a question set through searchMateri and
 * writes result files in the shape the retrieval test's scorer reads
 * ({ questionId: [{ jalur, halaman }] }).
 *
 *   npx tsx scripts/materi-index-gate.ts <set-uji.json> <output dir>
 *
 * Four files are written: vector-only and reranked, each with the course
 * filter and across all courses. Costs two Voyage embedding calls and two
 * rerank calls per question; no chat-model calls.
 */

import fs from "node:fs";
import path from "node:path";

import { searchMateri, type MateriHit } from "../src/server/materi-index.ts";

interface Question {
	id: string;
	q: string;
	matkul: string;
}

const [setFile, outDir] = process.argv.slice(2);
if (!setFile || !outDir) {
	console.error("usage: npx tsx scripts/materi-index-gate.ts <set-uji.json> <output dir>");
	process.exit(1);
}

const questions = JSON.parse(fs.readFileSync(setFile, "utf8")) as Question[];
const shape = (hits: MateriHit[]) => hits.map((h) => ({ jalur: h.doc, halaman: h.page }));
type Shaped = Record<string, { jalur: string; halaman: number | null }[]>;
const vectorFiltered: Shaped = {};
const rerankFiltered: Shaped = {};
const vectorAll: Shaped = {};
const rerankAll: Shaped = {};
const usage = { questions: questions.length, embedTokens: 0, rerankTokens: 0, rerankCalls: 0, returnedChars: 0, ms: 0 };

for (const [n, question] of questions.entries()) {
	const started = Date.now();
	const filtered = await searchMateri(question.q, { matkul: question.matkul });
	usage.ms += Date.now() - started;
	const all = await searchMateri(question.q);
	vectorFiltered[question.id] = shape(filtered.vectorHits);
	rerankFiltered[question.id] = shape(filtered.hits);
	vectorAll[question.id] = shape(all.vectorHits);
	rerankAll[question.id] = shape(all.hits);
	for (const r of [filtered, all]) {
		usage.embedTokens += r.usage.embedTokens;
		usage.rerankTokens += r.usage.rerankTokens;
		usage.rerankCalls += 1;
	}
	usage.returnedChars += filtered.hits.slice(0, 5).reduce((sum, h) => sum + h.text.length, 0);
	console.log(`  question ${n + 1}/${questions.length}`);
}

const out: [string, Shaped][] = [
	["lh-voyage4-large", vectorFiltered],
	["lh-voyage4-large-rerank-3", rerankFiltered],
	["lh-voyage4-large-semua-matkul", vectorAll],
	["lh-voyage4-large-rerank-3-semua-matkul", rerankAll],
];
for (const [name, value] of out) {
	fs.writeFileSync(path.join(outDir, `hasil-${name}.json`), JSON.stringify(value));
}
fs.writeFileSync(path.join(outDir, "pemakaian-gerbang-lh.json"), JSON.stringify(usage, null, 1));
console.log("DONE", JSON.stringify(usage));

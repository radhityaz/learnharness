import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import { createMateriTools, formatHits, resolveCourse } from "../src/agent/tools/materi.ts";
import type { MateriSearchPort } from "../src/core/materi.ts";
import { EMBED_MODEL } from "../src/core/pdf-index.ts";
import { buildMateriFts, exactSearchMateri, ftsTerms, materiSearchPort } from "../src/server/materi-index.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";

const COURSES = [
	{ matkul: "matkul-mr4062-manajemen-proyek", rows: 3 },
	{ matkul: "matkul-ti3105-sistem-produksi", rows: 1 },
];

/** A two-shard index with dim 2 in a temp dir. */
function writeIndex(dir: string): void {
	const shards: Record<string, [string, number | null, string][]> = {
		"matkul-mr4062-manajemen-proyek": [
			["ch08.pdf", 22, "Total slack is LS minus ES. Free slack is smaller."],
			["ch08.pdf", 22, "Total slack again on the same page."],
			["buku.pdf", 195, "The critical path has zero slack."],
		],
		"matkul-ti3105-sistem-produksi": [["tps.pdf", 414, "Computation of the number of kanban."]],
	};
	const manifest = {
		version: 1,
		model: EMBED_MODEL,
		dim: 2,
		rows: 4,
		shards: Object.entries(shards).map(([matkul, rows]) => ({ matkul, rows: rows.length })),
	};
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
	for (const [matkul, rows] of Object.entries(shards)) {
		const texts: Buffer[] = [];
		const refs: [string, number | null, number, number][] = [];
		let offset = 0;
		for (const [doc, page, text] of rows) {
			const b = Buffer.from(text, "utf8");
			refs.push([doc, page, offset, b.length]);
			texts.push(b);
			offset += b.length;
		}
		fs.writeFileSync(path.join(dir, `${matkul}.texts.bin`), Buffer.concat(texts));
		fs.writeFileSync(path.join(dir, `${matkul}.rows.json`), JSON.stringify(refs));
		fs.writeFileSync(path.join(dir, `${matkul}.f32`), Buffer.from(new Float32Array(rows.length * 2).fill(Math.SQRT1_2).buffer));
	}
}

test("ftsTerms quotes every term, keeps phrases, drops punctuation-only terms", () => {
	assert.deepEqual(ftsTerms('"free slack" LS - ES'), ['"free slack"', '"LS"', '"ES"']);
	assert.deepEqual(ftsTerms("a\"b OR NOT"), ['"a""b"', '"OR"', '"NOT"']);
	assert.deepEqual(ftsTerms("  ()  "), []);
});

test("exact search: all terms, any-term fallback, course filter, page de-duplication, stale stamp", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-materi-"));
	const prev = process.env.LH_MATERI_INDEX_DIR;
	process.env.LH_MATERI_INDEX_DIR = dir;
	try {
		writeIndex(dir);
		assert.throws(() => exactSearchMateri("slack"), /not built/);
		assert.equal(buildMateriFts(), 4);

		const all = exactSearchMateri("total slack");
		assert.equal(all.match, "all");
		assert.deepEqual(all.hits.map((h) => [h.doc, h.page]), [["ch08.pdf", 22]], "two chunks of one page = one hit");
		assert.match(all.hits[0]?.text ?? "", /\[Total\] \[slack\]/);

		const any = exactSearchMateri("kanban zzqq");
		assert.equal(any.match, "any");
		assert.deepEqual(any.hits.map((h) => h.doc), ["tps.pdf"]);

		const filtered = exactSearchMateri("kanban", { matkul: "matkul-mr4062-manajemen-proyek" });
		assert.equal(filtered.hits.length, 0);
		assert.throws(() => exactSearchMateri("x", { matkul: "nope" }), /Unknown course/);

		const port = materiSearchPort();
		assert.ok(port);
		assert.equal(port.courses().length, 2);

		// A manifest change invalidates the FTS file instead of searching stale text.
		const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
		m.version = 2;
		const file = path.join(dir, "manifest.json");
		fs.writeFileSync(file, JSON.stringify(m));
		fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // a distinct mtime
		assert.throws(() => exactSearchMateri("slack"), /out of date/);
	} finally {
		if (prev === undefined) delete process.env.LH_MATERI_INDEX_DIR;
		else process.env.LH_MATERI_INDEX_DIR = prev;
	}
});

test("resolveCourse accepts a code, the full id, or nothing", () => {
	assert.equal(resolveCourse(COURSES, undefined), undefined);
	assert.equal(resolveCourse(COURSES, " MR4062 "), "matkul-mr4062-manajemen-proyek");
	assert.equal(resolveCourse(COURSES, "matkul-ti3105-sistem-produksi"), "matkul-ti3105-sistem-produksi");
	assert.match(String(resolveCourse(COURSES, "TI9999")), /No course matches/);
	assert.match(String(resolveCourse(COURSES, "matkul")), /more than one course/);
});

test("formatHits prints path, page, course, and excerpt", () => {
	assert.equal(formatHits([], "x"), "x: no pages found.");
	const out = formatHits([{ matkul: "m", doc: "d.pdf", page: null, score: 0.5, text: " hi " }], "h");
	assert.equal(out, "h: 1 page, best first.\n\n[1] d.pdf | no page | m | score 0.500\nhi");
});

test("materi tools pass the course and limit through and never throw", async () => {
	const calls: unknown[] = [];
	const port: MateriSearchPort = {
		courses: () => COURSES,
		semantic: async (query, opts) => {
			calls.push({ query, matkul: opts?.matkul, limit: opts?.limit });
			return [{ matkul: "matkul-mr4062-manajemen-proyek", doc: "ch08.pdf", page: 22, score: 0.9, text: "slack" }];
		},
		exact: async () => {
			throw new Error("boom");
		},
	};
	const tools = createMateriTools(port);
	const search = tools.materi_search;
	const exact = tools.materi_exact;
	assert.ok(search && exact);
	const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

	const ok = await search.execute("t1", { query: "kenapa slack nol", course: "mr4062" });
	assert.match(text(ok), /\[1\] ch08\.pdf \| p\. 22/);
	assert.deepEqual(calls, [{ query: "kenapa slack nol", matkul: "matkul-mr4062-manajemen-proyek", limit: 5 }]);

	const badCourse = await search.execute("t2", { query: "x", course: "TI9999" });
	assert.match(text(badCourse), /No course matches/);
	assert.equal(calls.length, 1, "an unknown course makes no paid call");

	const failed = await exact.execute("t3", { query: "x" });
	assert.equal(text(failed), "materi_exact failed: boom");
});

test("teacher registry has the materi tools only when an index is installed", () => {
	const base: TeacherToolContext = { chatId: "materi-test", chatStore, jobStore, spawn: () => {} };
	const port: MateriSearchPort = {
		courses: () => COURSES,
		semantic: async () => [],
		exact: async () => ({ hits: [], match: "all" }),
	};
	assert.ok(!("materi_search" in createTeacherTools(base)));
	assert.ok(!("materi_search" in createTeacherTools({ ...base, materi: () => null })));
	assert.ok(!("materi_search" in createTeacherTools({ ...base, materi: () => { throw new Error("x"); } })));
	const tools = createTeacherTools({ ...base, materi: () => port });
	assert.ok("materi_search" in tools && "materi_exact" in tools);
});

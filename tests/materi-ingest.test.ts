import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	PAGE_CHUNK_CHARS,
	chunkPage,
	isDuplicateDoc,
	matchPages,
	matkulFromInboxPath,
	mostMatchedDoc,
	ocrToText,
	parseOcrBlocks,
} from "../src/core/materi-ingest.ts";
import { EMBED_MODEL, pageWords } from "../src/core/pdf-index.ts";
import type { PdfPage } from "../src/agent/subagents/pdf-markdown.ts";
import { appendToMateriIndex, buildMateriFts, exactSearchMateri, materiCourses } from "../src/server/materi-index.ts";
import {
	ingestFile,
	readSources,
	resetInboxMemory,
	scanInbox,
	type IngestDeps,
} from "../src/server/materi-ingest.ts";

const OCR_RAW =
	"<｜ref｜>sub_title<｜/ref｜><｜box｜>[[56,0,728,65]]<｜/box｜> # Forward pass\n" +
	"<｜ref｜>text<｜/ref｜><｜box｜>[[114,162,380,206]]<｜/box｜> - ES equals the largest EF of predecessors\n" +
	"<｜ref｜>image<｜/ref｜><｜box｜>[[10,300,990,900]]<｜/box｜>";

test("chunkPage: one chunk per page, long pages split by paragraph, empty pages dropped", () => {
	assert.deepEqual(chunkPage(3, "  \n\n "), []);
	assert.deepEqual(chunkPage(1, "# Judul\nisi\n\n\n\nlagi"), [{ page: 1, title: "Judul", text: "# Judul\nisi\n\nlagi" }]);
	const para = "x".repeat(PAGE_CHUNK_CHARS / 2);
	const long = chunkPage(2, [para, para, para].join("\n\n"));
	assert.equal(long.length, 2);
	// The old rule compares before adding the paragraph separator, so a chunk may run 2 characters over.
	assert.ok(long.every((c) => c.text.length <= PAGE_CHUNK_CHARS + 2 && c.page === 2));
});

test("OCR output: blocks keep their boxes, text drops the markers", () => {
	const blocks = parseOcrBlocks(OCR_RAW);
	assert.deepEqual(
		blocks.map((b) => [b.label, b.box]),
		[["sub_title", [56, 0, 728, 65]], ["text", [114, 162, 380, 206]], ["image", [10, 300, 990, 900]]],
	);
	assert.equal(ocrToText(OCR_RAW), "# Forward pass\n\n- ES equals the largest EF of predecessors");
	assert.deepEqual(parseOcrBlocks("plain text only"), [{ label: "text", box: null, text: "plain text only" }]);
});

test("matkulFromInboxPath takes the first folder", () => {
	assert.equal(matkulFromInboxPath("matkul-mr4062-manajemen-proyek/Slide/ch08.pdf"), "matkul-mr4062-manajemen-proyek");
	assert.equal(matkulFromInboxPath("loose.pdf"), null);
	assert.equal(matkulFromInboxPath("../x/y.pdf"), null);
});

function tempEnv(): { index: string; inbox: string; restore: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ingest-"));
	const index = path.join(root, "materi-index");
	const inbox = path.join(root, "materi-inbox");
	fs.mkdirSync(inbox, { recursive: true });
	const prev = { i: process.env.LH_MATERI_INDEX_DIR, b: process.env.LH_MATERI_INBOX };
	process.env.LH_MATERI_INDEX_DIR = index;
	process.env.LH_MATERI_INBOX = inbox;
	resetInboxMemory();
	return {
		index,
		inbox,
		restore: () => {
			for (const [k, v] of [["LH_MATERI_INDEX_DIR", prev.i], ["LH_MATERI_INBOX", prev.b]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		},
	};
}

function fakeDeps(calls: { render: number[][]; ocr: string[]; embed: number }): IngestDeps {
	return {
		convert: async () => [
			{ kind: "text", number: 1, markdown: `# Network\n${"The activity network has nodes and arrows. ".repeat(8)}` },
			{ kind: "text", number: 2, markdown: "Forward" },
			{ kind: "image-only", number: 3 },
			{ kind: "empty", number: 4 },
		],
		render: async (_pdf, pages) => {
			calls.render.push(pages);
			return pages.map((page) => ({ page, png: Buffer.from(`png${page}`) }));
		},
		ocr: async (_png, name) => {
			calls.ocr.push(name);
			return name === "3.png" ? "" : OCR_RAW;
		},
		embed: async (texts) => {
			calls.embed++;
			return { vectors: texts.map(() => Float32Array.from([0.6, 0.8])), tokens: texts.length * 10 };
		},
		now: () => new Date("2026-11-24T12:00:00Z"),
	};
}

test("ingest: a new PDF is OCR'd on weak pages, embedded, indexed, and registered; the same bytes are a duplicate", async () => {
	const env = tempEnv();
	try {
		// An existing one-shard index with a current FTS file.
		appendToMateriIndex("matkul-mr4062-manajemen-proyek", [
			{ doc: "materi/old.pdf/markdown.md", page: 1, text: "Old\nslack page", vector: Float32Array.from([1, 0]) },
		]);
		buildMateriFts();
		const legacyBytes = Buffer.from("legacy pdf bytes");
		fs.writeFileSync(
			path.join(env.index, "sources.json"),
			JSON.stringify({
				version: 1,
				docs: [{ doc: "materi/old.pdf/markdown.md", matkul: "matkul-mr4062-manajemen-proyek", sha256: createHash("sha256").update(legacyBytes).digest("hex"), pdf: null, origin: "legacy" }],
			}),
		);

		const dir = path.join(env.inbox, "matkul-mr4062-manajemen-proyek", "Slide");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "ch08.pdf"), "new pdf bytes");
		fs.writeFileSync(path.join(dir, "old-copy.pdf"), legacyBytes);

		const calls = { render: [] as number[][], ocr: [] as string[], embed: 0 };
		const deps = fakeDeps(calls);

		const old = await ingestFile("matkul-mr4062-manajemen-proyek/Slide/old-copy.pdf", deps);
		assert.equal(old.status, "duplicate");
		assert.equal(old.doc, "materi/old.pdf/markdown.md");
		assert.equal(calls.embed, 0, "a known PDF costs nothing");

		const out = await ingestFile("matkul-mr4062-manajemen-proyek/Slide/ch08.pdf", deps);
		assert.equal(out.status, "ingested", out.note);
		assert.deepEqual(calls.render, [[2, 3]], "only weak pages are rendered");
		assert.equal(out.ocrPages, 2);
		assert.equal(out.chunks, 2, "page 3 OCR'd to nothing and page 4 is empty");
		assert.equal(out.embedTokens, 20);

		const courses = materiCourses();
		assert.deepEqual(courses, [{ matkul: "matkul-mr4062-manajemen-proyek", rows: 3 }]);
		const hit = exactSearchMateri("largest EF");
		assert.equal(hit.hits[0]?.doc, "materi-inbox/matkul-mr4062-manajemen-proyek/Slide/ch08.pdf");
		assert.equal(hit.hits[0]?.page, 2);
		assert.equal(exactSearchMateri("slack").hits.length, 1, "old rows still searchable after the append");

		const entry = readSources().docs.find((d) => d.origin === "ingested");
		assert.equal(entry?.pages, 4);
		assert.deepEqual(entry?.ocrPages, [2, 3]);
		const pagesDir = path.join(path.dirname(env.index), "materi-pages", entry?.sha256 ?? "");
		assert.ok(fs.existsSync(path.join(pagesDir, "2.png")));
		assert.match(fs.readFileSync(path.join(pagesDir, "ocr.json"), "utf8"), /sub_title/);

		const again = await ingestFile("matkul-mr4062-manajemen-proyek/Slide/ch08.pdf", deps);
		assert.equal(again.status, "duplicate");
	} finally {
		env.restore();
	}
});

test("ingest: a new course gets its own shard; failures come back as outcomes", async () => {
	const env = tempEnv();
	try {
		fs.mkdirSync(path.join(env.inbox, "matkul-baru"), { recursive: true });
		fs.writeFileSync(path.join(env.inbox, "matkul-baru", "a.pdf"), "a");
		const calls = { render: [] as number[][], ocr: [] as string[], embed: 0 };
		const ok = await ingestFile("matkul-baru/a.pdf", fakeDeps(calls));
		assert.equal(ok.status, "ingested", ok.note);
		const manifest = JSON.parse(fs.readFileSync(path.join(env.index, "manifest.json"), "utf8"));
		assert.equal(manifest.model, EMBED_MODEL);
		assert.deepEqual(manifest.shards.map((s: { matkul: string }) => s.matkul), ["matkul-baru"]);

		fs.writeFileSync(path.join(env.inbox, "matkul-baru", "b.pdf"), "b");
		const broken = await ingestFile("matkul-baru/b.pdf", { ...fakeDeps(calls), convert: async () => null });
		assert.equal(broken.status, "failed");
		const ocrDown = await ingestFile("matkul-baru/b.pdf", {
			...fakeDeps(calls),
			ocr: async () => {
				throw new Error("DeepSeek OCR failed: HTTP 402");
			},
		});
		assert.equal(ocrDown.status, "failed");
		assert.match(ocrDown.note ?? "", /402/);
		assert.equal(readSources().docs.length, 1, "a failed file is not registered, so it is retried later");
	} finally {
		env.restore();
	}
});

test("scanInbox waits for files to settle, skips loose files, logs each outcome once", async () => {
	const env = tempEnv();
	try {
		fs.mkdirSync(path.join(env.inbox, "matkul-x"), { recursive: true });
		fs.writeFileSync(path.join(env.inbox, "matkul-x", "a.pdf"), "a");
		fs.writeFileSync(path.join(env.inbox, "loose.pdf"), "l");
		const calls = { render: [] as number[][], ocr: [] as string[], embed: 0 };
		const deps = fakeDeps(calls);
		const mtime = fs.statSync(path.join(env.inbox, "matkul-x", "a.pdf")).mtimeMs;

		assert.deepEqual(await scanInbox(deps, () => mtime + 1_000), [], "still settling");
		const first = await scanInbox(deps, () => mtime + 60_000);
		assert.deepEqual(first.map((o) => [o.file, o.status]), [["loose.pdf", "skipped"], ["matkul-x/a.pdf", "ingested"]]);
		assert.deepEqual(await scanInbox(deps, () => mtime + 120_000), [], "handled files are not re-read");
		const log = fs.readFileSync(path.join(env.index, "ingest-log.jsonl"), "utf8").trim().split("\n");
		assert.equal(log.length, 2);
	} finally {
		env.restore();
	}
});

// Three slides of an old deck; each has enough words to compare.
const SLIDES = [
	"Partitional clustering divides data objects into non-overlapping subsets so that each object is in exactly one subset",
	"Hierarchical clustering produces a set of nested clusters organized as a hierarchical tree called a dendrogram",
	"The K-means algorithm assigns each point to the cluster with the closest centroid and then recomputes every centroid",
	"Limitations of K-means appear when clusters have differing sizes differing densities or non-globular shapes",
];

test("matchPages: pages already in the course point at their document; a mostly-old file is a copy", () => {
	const course = [
		{ doc: "old/M9.pdf", words: pageWords(SLIDES[0] as string) },
		{ doc: "old/M9.pdf", words: pageWords(SLIDES[1] as string) },
		{ doc: "old/M10.pdf", words: pageWords(SLIDES[2] as string) },
	];
	const { comparable, matches } = matchPages(
		[
			{ page: 1, text: `# Slide\n${SLIDES[0]}` },
			{ page: 2, text: SLIDES[1] as string },
			{ page: 3, text: SLIDES[3] as string },
			{ page: 4, text: "Thanks" },
		],
		course,
	);
	assert.equal(comparable, 3, "a thin page is not compared");
	assert.deepEqual([...matches.keys()], [1, 2]);
	assert.equal(mostMatchedDoc(matches), "old/M9.pdf");
	assert.equal(isDuplicateDoc(3, 2), false);
	assert.equal(isDuplicateDoc(10, 8), true);
	assert.equal(isDuplicateDoc(2, 2), false, "too few pages to judge the whole file");
});

function deckDeps(pages: PdfPage[], calls: { render: number[][]; ocr: string[]; embed: number }): IngestDeps {
	return { ...fakeDeps(calls), convert: async () => pages };
}

test("ingest: a re-downloaded deck (other bytes, same slides) is a duplicate and costs nothing; a revised deck keeps only its new pages", async () => {
	const env = tempEnv();
	try {
		appendToMateriIndex(
			"matkul-ti4005",
			SLIDES.slice(0, 3).map((s, i) => ({ doc: "materi/M9.pdf/markdown.md", page: i + 1, text: `M9\n${s}`, vector: Float32Array.from([1, 0]) })),
		);
		const dir = path.join(env.inbox, "matkul-ti4005");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "M9-copy.pdf"), "other bytes");
		fs.writeFileSync(path.join(dir, "M9-rev.pdf"), "revised bytes");

		const calls = { render: [] as number[][], ocr: [] as string[], embed: 0 };
		const copyPages: PdfPage[] = [
			...SLIDES.slice(0, 3).map((s, i) => ({ kind: "text" as const, number: i + 1, markdown: `# Slide ${i + 1}\n${s}.` })),
			{ kind: "image-only", number: 4 },
		];
		const copy = await ingestFile("matkul-ti4005/M9-copy.pdf", deckDeps(copyPages, calls));
		assert.equal(copy.status, "duplicate", copy.note);
		assert.equal(copy.doc, "materi/M9.pdf/markdown.md");
		assert.deepEqual([calls.render, calls.ocr, calls.embed], [[], [], 0], "no OCR, no embedding");
		assert.equal(readSources().docs.find((d) => d.doc.endsWith("M9-copy.pdf"))?.duplicateOf, "materi/M9.pdf/markdown.md");
		assert.equal(materiCourses()[0]?.rows, 3, "nothing appended");
		const again = await ingestFile("matkul-ti4005/M9-copy.pdf", deckDeps(copyPages, calls));
		assert.equal(again.doc, "materi/M9.pdf/markdown.md", "the registered copy points at the original");

		const revPages: PdfPage[] = [
			{ kind: "text", number: 1, markdown: SLIDES[0] as string },
			{ kind: "text", number: 2, markdown: SLIDES[3] as string },
			{ kind: "text", number: 3, markdown: "A brand new slide about the elbow method for choosing the number of clusters k" },
		];
		const rev = await ingestFile("matkul-ti4005/M9-rev.pdf", deckDeps(revPages, calls));
		assert.equal(rev.status, "ingested", rev.note);
		assert.equal(rev.chunks, 2, "the old slide is left out");
		assert.deepEqual(readSources().docs.find((d) => d.doc.endsWith("M9-rev.pdf"))?.skippedPages, [1]);
		assert.equal(materiCourses()[0]?.rows, 5);
	} finally {
		env.restore();
	}
});

test("exact search shows one copy of a page indexed from two files", () => {
	const env = tempEnv();
	try {
		appendToMateriIndex("matkul-ti4005", [
			{ doc: "a/M9.pdf", page: 36, text: `M9\n${SLIDES[3]}`, vector: Float32Array.from([1, 0]) },
			{ doc: "b/M9 (1).pdf", page: 36, text: `M9 (1)\n${SLIDES[3]}`, vector: Float32Array.from([1, 0]) },
			{ doc: "c/M10.pdf", page: 2, text: "M10\nDBSCAN handles non-globular shapes that K-means cannot separate well at all", vector: Float32Array.from([0, 1]) },
		]);
		buildMateriFts();
		const hits = exactSearchMateri("non-globular").hits;
		assert.deepEqual(hits.map((h) => h.doc).sort(), ["a/M9.pdf", "c/M10.pdf"]);
	} finally {
		env.restore();
	}
});

test("ingest: a shortened copy with one page of its own is not OCR'd and indexes only that page", async () => {
	const env = tempEnv();
	try {
		appendToMateriIndex(
			"matkul-ti4005",
			SLIDES.map((s, i) => ({ doc: "materi/M6.pdf/markdown.md", page: i + 1, text: `M6\n${s}`, vector: Float32Array.from([1, 0]) })),
		);
		buildMateriFts();
		fs.mkdirSync(path.join(env.inbox, "matkul-ti4005"), { recursive: true });
		fs.writeFileSync(path.join(env.inbox, "matkul-ti4005", "M7.pdf"), "m7 bytes");
		const calls = { render: [] as number[][], ocr: [] as string[], embed: 0 };
		const deck: PdfPage[] = [
			...SLIDES.map((s, i) => ({ kind: "text" as const, number: i + 1, markdown: s })),
			{ kind: "text", number: 5, markdown: "Tugas kelompok: review satu paper tentang CNN dan satu paper tentang RL di bidang teknik industri" },
			{ kind: "image-only", number: 6 },
		];
		const out = await ingestFile("matkul-ti4005/M7.pdf", deckDeps(deck, calls));
		assert.equal(out.status, "ingested", out.note);
		assert.equal(out.chunks, 1);
		assert.deepEqual(calls.render, [], "a near copy is never OCR'd");
		const entry = readSources().docs.find((d) => d.doc.endsWith("M7.pdf"));
		assert.equal(entry?.nearCopyOf, "materi/M6.pdf/markdown.md");
		assert.deepEqual(entry?.skippedPages, [1, 2, 3, 4, 6]);
		assert.equal(exactSearchMateri("tugas kelompok").hits[0]?.page, 5);
	} finally {
		env.restore();
	}
});

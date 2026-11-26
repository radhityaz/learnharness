/**
 * Word/PowerPoint in the materi inbox: converted to PDF beside the original,
 * the original moved to materi-files, the PDF ingested. A machine with no
 * converter skips the file with a note and leaves it where it is.
 * (The converter is faked here; the live Office/LibreOffice path is not run in CI.)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ingestOfficeFile, listInbox, resetInboxMemory, type IngestDeps } from "../src/server/materi-ingest.ts";
import { isOfficeFile } from "../src/server/office-convert.ts";

const MATKUL = "matkul-mr4062-manajemen-proyek";
const SAMPLE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

function env() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-office-"));
	const prev = { i: process.env.LH_MATERI_INDEX_DIR, b: process.env.LH_MATERI_INBOX };
	process.env.LH_MATERI_INDEX_DIR = path.join(root, "materi-index");
	process.env.LH_MATERI_INBOX = path.join(root, "materi-inbox");
	fs.mkdirSync(path.join(process.env.LH_MATERI_INBOX, MATKUL, "Slide"), { recursive: true });
	resetInboxMemory();
	return {
		root,
		inbox: process.env.LH_MATERI_INBOX,
		restore: () => {
			for (const [k, v] of [["LH_MATERI_INDEX_DIR", prev.i], ["LH_MATERI_INBOX", prev.b]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				// Windows may hold a handle
			}
		},
	};
}

function deps(office: IngestDeps["office"]): IngestDeps {
	return {
		convert: async () => [{ kind: "text", number: 1, markdown: `# CPM\n${"Forward pass computes ES and EF for each activity. ".repeat(6)}` }],
		render: async () => [],
		ocr: async () => "",
		embed: async (texts) => ({ vectors: texts.map(() => Float32Array.from([0.6, 0.8])), tokens: texts.length }),
		now: () => new Date("2026-11-26T00:00:00Z"),
		courseWords: () => [],
		office,
	};
}

test("the inbox lists Word and PowerPoint files beside PDFs", () => {
	assert.equal(isOfficeFile("a.PPTX"), true);
	assert.equal(isOfficeFile("a.docx"), true);
	assert.equal(isOfficeFile("a.xlsx"), false);
	const e = env();
	try {
		for (const f of ["a.pdf", "b.pptx", "c.docx", "d.txt", "e.pdf.password"]) fs.writeFileSync(path.join(e.inbox, MATKUL, f), "x");
		assert.deepEqual(listInbox(), [`${MATKUL}/a.pdf`, `${MATKUL}/b.pptx`, `${MATKUL}/c.docx`]);
	} finally {
		e.restore();
	}
});

test("a PowerPoint file is converted, its original kept in materi-files, and the PDF indexed", async () => {
	const e = env();
	try {
		const pptx = path.join(e.inbox, MATKUL, "Slide", "ch08.pptx");
		fs.writeFileSync(pptx, "pptx bytes");
		const seen: string[] = [];
		const out = await ingestOfficeFile(
			`${MATKUL}/Slide/ch08.pptx`,
			deps(() => ({
				name: "Fake Office",
				convert: async (input, pdf) => {
					seen.push(path.basename(input), path.basename(pdf));
					fs.copyFileSync(SAMPLE, pdf);
				},
			})),
		);
		assert.equal(out.status, "ingested", out.note);
		assert.equal(out.convertedFrom, "ch08.pptx");
		assert.match(out.note ?? "", /Converted from ch08\.pptx with Fake Office/);
		assert.deepEqual(seen, ["ch08.pptx", "ch08.pdf"]);
		assert.equal(out.file, `${MATKUL}/Slide/ch08.pdf`);
		const files = path.join(e.root, "materi-files", MATKUL, "Slide");
		assert.ok(fs.existsSync(path.join(files, "ch08.pptx")), "original kept once, in materi-files");
		assert.ok(fs.existsSync(path.join(files, "ch08.pdf")), "the PDF moved next to it");
		assert.equal(fs.existsSync(pptx), false, "the inbox is empty again");
	} finally {
		e.restore();
	}
});

test("no converter: skipped with a note, the file stays in the inbox", async () => {
	const e = env();
	try {
		const docx = path.join(e.inbox, MATKUL, "notes.docx");
		fs.writeFileSync(docx, "docx bytes");
		const out = await ingestOfficeFile(`${MATKUL}/notes.docx`, deps(() => null));
		assert.equal(out.status, "skipped");
		assert.match(out.note ?? "", /LibreOffice or Microsoft Office/);
		assert.ok(fs.existsSync(docx));
	} finally {
		e.restore();
	}
});

test("a failed conversion is a failed outcome, never a throw", async () => {
	const e = env();
	try {
		fs.writeFileSync(path.join(e.inbox, MATKUL, "bad.ppt"), "x");
		const out = await ingestOfficeFile(
			`${MATKUL}/bad.ppt`,
			deps(() => ({ name: "Fake Office", convert: async () => Promise.reject(new Error("file is corrupt")) })),
		);
		assert.equal(out.status, "failed");
		assert.match(out.note ?? "", /Conversion with Fake Office failed: file is corrupt/);
	} finally {
		e.restore();
	}
});

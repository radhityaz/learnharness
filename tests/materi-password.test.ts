/**
 * Password-protected course PDFs: the real pdf.js reader on a fixture whose
 * user password is "kuliah" (3 pages of text). Without a password the ingest
 * says how to supply one; with a sidecar `<name>.password` it is read,
 * rendered and indexed, the password is kept by hash, the sidecar removed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { convertPdf } from "../src/agent/subagents/pdf-ops.ts";
import { getHeadless } from "../src/agent/subagents/headless.ts";
import { defaultDeps, ingestFile, resetInboxMemory, type IngestDeps } from "../src/server/materi-ingest.ts";
import { pdfPassword, readSidecar } from "../src/server/materi-passwords.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "materi-password-kuliah.pdf");
const MATKUL = "matkul-mr4062-manajemen-proyek";

function tempEnv() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pw-"));
	const prev = { i: process.env.LH_MATERI_INDEX_DIR, b: process.env.LH_MATERI_INBOX };
	process.env.LH_MATERI_INDEX_DIR = path.join(root, "materi-index");
	process.env.LH_MATERI_INBOX = path.join(root, "materi-inbox");
	fs.mkdirSync(path.join(process.env.LH_MATERI_INBOX, MATKUL), { recursive: true });
	resetInboxMemory();
	return {
		inbox: process.env.LH_MATERI_INBOX,
		restore: () => {
			for (const [k, v] of [["LH_MATERI_INDEX_DIR", prev.i], ["LH_MATERI_INBOX", prev.b]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				// Windows may hold a handle; temp dirs are cleaned by the OS
			}
		},
	};
}

test("pdf.js: no password = passwordProtected, right password = pages", async () => {
	const data = new Uint8Array(fs.readFileSync(FIXTURE));
	const locked = await convertPdf(data.slice(), 100);
	assert.equal(locked.kind, "unreadable");
	assert.equal(locked.kind === "unreadable" && locked.passwordProtected, true);
	const wrong = await convertPdf(data.slice(), 100, { password: "salah" });
	assert.equal(wrong.kind === "unreadable" && wrong.passwordProtected, true);
	const open = await convertPdf(data.slice(), 100, { password: "kuliah" });
	assert.equal(open.kind, "converted");
	assert.equal(open.kind === "converted" && open.pages.length, 3);
});

test("render: a password-protected page renders with its password", async () => {
	const [page] = await getHeadless().renderPdfPages(FIXTURE, [1], { dpi: 50, password: "kuliah" });
	assert.ok(page && page.png.length > 100);
	await assert.rejects(getHeadless().renderPdfPages(FIXTURE, [1], { dpi: 50 }));
});

test("ingest: asks for a sidecar, then uses it once and keeps the password by hash", async () => {
	const env = tempEnv();
	try {
		const live = defaultDeps();
		const rendered: string[] = [];
		const deps: IngestDeps = {
			convert: live.convert,
			render: async (pdf, pages, password) => {
				const out = await live.render(pdf, pages, password);
				rendered.push(...out.map((p) => String(p.page)));
				return out;
			},
			ocr: async () => "",
			embed: async (texts) => ({ vectors: texts.map(() => Float32Array.from([0.6, 0.8])), tokens: texts.length }),
			now: () => new Date("2026-11-26T00:00:00Z"),
			courseWords: () => [],
		};
		const pdf = path.join(env.inbox, MATKUL, "ch08-locked.pdf");
		fs.copyFileSync(FIXTURE, pdf);

		const first = await ingestFile(`${MATKUL}/ch08-locked.pdf`, deps);
		assert.equal(first.status, "failed");
		assert.match(first.note ?? "", /password-protected.*ch08-locked\.pdf\.password/);

		fs.writeFileSync(`${pdf}.password`, "salah\n");
		const wrong = await ingestFile(`${MATKUL}/ch08-locked.pdf`, deps);
		assert.equal(wrong.status, "failed");
		assert.match(wrong.note ?? "", /does not open/);

		fs.writeFileSync(`${pdf}.password`, "kuliah\n");
		const ok = await ingestFile(`${MATKUL}/ch08-locked.pdf`, deps);
		assert.equal(ok.status, "ingested", ok.note);
		assert.equal(ok.pages, 3);
		assert.ok(rendered.length > 0, "weak pages were rendered with the password for OCR");
		assert.equal(readSidecar(pdf), null, "the sidecar is removed after use");
		assert.equal(pdfPassword(ok.sha256), "kuliah");
	} finally {
		env.restore();
	}
});

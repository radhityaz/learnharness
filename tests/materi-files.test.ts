import assert from "node:assert/strict";
import { tempDir } from "./helpers/temp-dir.ts";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materiFilesDir, sourcePdfPath, storeSourcePdf } from "../src/server/materi-files.ts";

function tempData(): { root: string; restore: () => void } {
	const root = tempDir("lh-files-");
	const prev = process.env.LH_MATERI_INDEX_DIR;
	process.env.LH_MATERI_INDEX_DIR = path.join(root, "materi-index");
	return {
		root,
		restore: () => {
			if (prev === undefined) delete process.env.LH_MATERI_INDEX_DIR;
			else process.env.LH_MATERI_INDEX_DIR = prev;
		},
	};
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("sourcePdfPath reads data-relative and older absolute paths", () => {
	const env = tempData();
	try {
		assert.equal(sourcePdfPath({ pdf: null }), null);
		assert.equal(sourcePdfPath({ pdf: "materi-files/m/a.pdf" }), path.join(env.root, "materi-files", "m", "a.pdf"));
		const abs = path.join(env.root, "elsewhere", "b.pdf");
		assert.equal(sourcePdfPath({ pdf: abs }), abs);
	} finally {
		env.restore();
	}
});

test("storeSourcePdf moves once per content; a taken name with other bytes gets the hash suffix", () => {
	const env = tempData();
	try {
		const src = path.join(env.root, "dl");
		fs.mkdirSync(src);
		const write = (name: string, body: string) => {
			fs.writeFileSync(path.join(src, name), body);
			return path.join(src, name);
		};

		const rel = storeSourcePdf(write("a.pdf", "one"), "matkul-x", "Slide/a.pdf", sha("one"));
		assert.equal(rel, "materi-files/matkul-x/Slide/a.pdf");
		assert.equal(fs.readFileSync(path.join(materiFilesDir(), "matkul-x", "Slide", "a.pdf"), "utf8"), "one");
		assert.ok(!fs.existsSync(path.join(src, "a.pdf")), "moved, not copied");

		// Same name, same bytes: the incoming copy is removed, the stored one is reused.
		assert.equal(storeSourcePdf(write("a.pdf", "one"), "matkul-x", "Slide/a.pdf", sha("one")), rel);
		assert.ok(!fs.existsSync(path.join(src, "a.pdf")));

		// Same name, other bytes: kept beside it under a suffixed name.
		const other = storeSourcePdf(write("a.pdf", "two"), "matkul-x", "Slide/a.pdf", sha("two"));
		assert.equal(other, `materi-files/matkul-x/Slide/a [${sha("two").slice(0, 8)}].pdf`);
		assert.equal(fs.readdirSync(path.join(materiFilesDir(), "matkul-x", "Slide")).length, 2);

		// Storing the stored file again is a no-op.
		const stored = sourcePdfPath({ pdf: rel }) as string;
		assert.equal(storeSourcePdf(stored, "matkul-x", "Slide/a.pdf", sha("one")), rel);
		assert.ok(fs.existsSync(stored));
	} finally {
		env.restore();
	}
});

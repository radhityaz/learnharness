/**
 * Materi files: one home for every original course PDF.
 *
 *   <data>/materi-files/<matkul>/<name>.pdf
 *
 * sources.json stores these as data-relative paths ("materi-files/…"), so
 * the data folder can move without breaking page display. Older entries may
 * still hold absolute paths; sourcePdfPath() reads both. One copy per
 * content: a file whose bytes are already stored is not stored again.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MateriSourceEntry } from "../core/materi-ingest.ts";
import { materiIndexDir } from "./materi-index.ts";

const FILES = "materi-files";

/** The data folder that holds materi-index, materi-pages, and materi-files. */
function materiDataDir(): string {
	return path.dirname(materiIndexDir());
}

export function materiFilesDir(): string {
	return path.join(/* turbopackIgnore: true */ materiDataDir(), FILES);
}

/** Absolute path of an entry's original PDF, or null when none is recorded. */
export function sourcePdfPath(entry: Pick<MateriSourceEntry, "pdf">): string | null {
	if (!entry.pdf) return null;
	return path.isAbsolute(entry.pdf) ? entry.pdf : path.join(/* turbopackIgnore: true */ materiDataDir(), ...entry.pdf.split("/"));
}

function fileSha256(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Keeps only characters Windows accepts in a file or folder name. */
function safeSegment(s: string): string {
	const cleaned = s.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
	return cleaned || "_";
}

function moveFile(from: string, to: string): void {
	try {
		fs.renameSync(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
		// Another drive: copy, check the size, then remove the original.
		fs.copyFileSync(from, to);
		if (fs.statSync(to).size !== fs.statSync(from).size) throw new Error(`Copy of ${from} is incomplete.`);
		fs.unlinkSync(from);
	}
}

/**
 * Moves one original PDF into materi-files/<matkul>/<subpath> and returns
 * its data-relative path for sources.json. When the target name is taken by
 * the same bytes, the incoming file is a duplicate: it is removed and the
 * stored copy is returned. Other bytes under the same name get the hash's
 * first 8 characters appended. `sha256` must be the file's real hash.
 */
export function storeSourcePdf(from: string, matkul: string, subpath: string, sha256: string): string {
	const parts = [matkul, ...subpath.split(/[\\/]/).filter((p) => p && p !== "." && p !== "..")].map(safeSegment);
	let rel = [FILES, ...parts].join("/");
	let target = path.join(/* turbopackIgnore: true */ materiDataDir(), ...rel.split("/"));
	if (path.resolve(from) === path.resolve(target)) return rel;
	if (fs.existsSync(target) && fileSha256(target) !== sha256) {
		const ext = path.extname(target);
		rel = `${rel.slice(0, rel.length - ext.length)} [${sha256.slice(0, 8)}]${ext}`;
		target = path.join(/* turbopackIgnore: true */ materiDataDir(), ...rel.split("/"));
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	if (fs.existsSync(target)) {
		if (fileSha256(target) !== sha256) throw new Error(`${target} holds other bytes.`);
		fs.unlinkSync(from);
		return rel;
	}
	moveFile(from, target);
	return rel;
}

/**
 * Passwords of password-protected course PDFs, so they can be read, OCR'd
 * and shown in Priming like any other PDF.
 *
 * The learner supplies a password once, as a text file next to the PDF in the
 * inbox: `<name>.pdf.password` or `<name>.password` (first line). After a
 * successful ingest it is kept here, keyed by the PDF's SHA-256:
 *
 *   <index>/pdf-passwords.json   { "<sha256>": "<password>" }
 *
 * and the sidecar file is removed. These are document passwords on the
 * learner's own machine (data/ is never committed); they are never logged,
 * never sent to a model, and never shown in the UI.
 */

import fs from "node:fs";
import path from "node:path";

import { materiIndexDir } from "./materi-index.ts";

function storePath(): string {
	return path.join(materiIndexDir(), "pdf-passwords.json");
}

function readStore(): Record<string, string> {
	try {
		const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** The saved password for a PDF's hash, if any. */
export function pdfPassword(sha256: string | undefined): string | undefined {
	if (!sha256) return undefined;
	const pw = readStore()[sha256];
	return typeof pw === "string" && pw.length > 0 ? pw : undefined;
}

/** Saves a PDF's password under its hash. */
export function savePdfPassword(sha256: string, password: string): void {
	const store = readStore();
	store[sha256] = password;
	fs.mkdirSync(materiIndexDir(), { recursive: true });
	const tmp = `${storePath()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
	fs.renameSync(tmp, storePath());
}

/** Sidecar candidates for an inbox PDF: `x.pdf.password`, then `x.password`. */
export function sidecarPaths(pdfAbs: string): string[] {
	return [`${pdfAbs}.password`, pdfAbs.replace(/\.pdf$/i, ".password")];
}

/** The sidecar that exists, with its password (first line, trimmed). */
export function readSidecar(pdfAbs: string): { file: string; password: string } | null {
	for (const file of sidecarPaths(pdfAbs)) {
		try {
			const password = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
			if (password) return { file, password };
		} catch {
			// not there
		}
	}
	return null;
}

/** Newest mtime among a PDF's sidecars (0 when none): adding one re-triggers the inbox scan. */
export function sidecarStamp(pdfAbs: string): number {
	let stamp = 0;
	for (const file of sidecarPaths(pdfAbs)) {
		try {
			stamp = Math.max(stamp, fs.statSync(file).mtimeMs);
		} catch {
			// not there
		}
	}
	return stamp;
}

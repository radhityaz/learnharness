/**
 * Word and PowerPoint files into PDF, so the materi inbox can take them.
 *
 * The converter is whatever the machine has, in this order:
 *   1. LibreOffice (`soffice`): LH_SOFFICE, PATH, or the standard install folder;
 *   2. on Windows, Microsoft Word / PowerPoint through COM (no window shown).
 * No converter = a clear error; the file stays in the inbox untouched.
 *
 * Paths reach the PowerShell script through environment variables, never
 * through the command line, so a file name cannot break out of the script.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OFFICE_EXTENSIONS = [".docx", ".doc", ".pptx", ".ppt"] as const;
const TIMEOUT_MS = 240_000;

export function isOfficeFile(name: string): boolean {
	return (OFFICE_EXTENSIONS as readonly string[]).includes(path.extname(name).toLowerCase());
}

function run(file: string, args: string[], env?: Record<string, string>): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, env: { ...process.env, ...env } }, (error, _stdout, stderr) => {
			if (error) reject(new Error(`${path.basename(file)} failed: ${String(stderr || error.message).trim().slice(0, 300)}`));
			else resolve();
		});
	});
}

/** LibreOffice's soffice, if installed. */
export function findSoffice(): string | null {
	const candidates = [
		process.env.LH_SOFFICE,
		...(process.platform === "win32"
			? [
					path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "LibreOffice", "program", "soffice.exe"),
					path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "LibreOffice", "program", "soffice.exe"),
				]
			: ["/usr/bin/soffice", "/usr/local/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"]),
		...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, process.platform === "win32" ? "soffice.exe" : "soffice")),
	].filter((p): p is string => Boolean(p));
	return candidates.find((p) => {
		try {
			return fs.statSync(p).isFile();
		} catch {
			return false;
		}
	}) ?? null;
}

// Word: ExportAsFixedFormat 17 = PDF. PowerPoint: SaveAs 32 = PDF; Open(path,
// ReadOnly, Untitled, WithWindow=false). Both apps are quit in finally.
const COM_SCRIPT = `
$ErrorActionPreference = 'Stop'
$in = $env:LH_OFFICE_IN; $out = $env:LH_OFFICE_OUT
$ext = [IO.Path]::GetExtension($in).ToLower()
if ($ext -eq '.doc' -or $ext -eq '.docx') {
  $app = New-Object -ComObject Word.Application
  try {
    $app.Visible = $false; $app.DisplayAlerts = 0
    $doc = $app.Documents.Open($in, $false, $true)
    try { $doc.ExportAsFixedFormat($out, 17) } finally { $doc.Close(0) }
  } finally { $app.Quit() }
} else {
  $app = New-Object -ComObject PowerPoint.Application
  try {
    $pres = $app.Presentations.Open($in, -1, 0, 0)
    try { $pres.SaveAs($out, 32) } finally { $pres.Close() }
  } finally { $app.Quit() }
}
`;

export interface OfficeConverter {
	/** Writes `out` (a PDF) from `input` (a Word/PowerPoint file). */
	convert(input: string, out: string): Promise<void>;
	name: string;
}

/** The converter this machine has, or null. */
export function officeConverter(): OfficeConverter | null {
	const soffice = findSoffice();
	if (soffice) {
		return {
			name: "LibreOffice",
			convert: async (input, out) => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-office-"));
				try {
					await run(soffice, ["--headless", "--convert-to", "pdf", "--outdir", dir, input]);
					const made = path.join(dir, `${path.parse(input).name}.pdf`);
					if (!fs.existsSync(made)) throw new Error("LibreOffice produced no PDF.");
					fs.copyFileSync(made, out);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			},
		};
	}
	if (process.platform === "win32") {
		return {
			name: "Microsoft Office",
			convert: async (input, out) => {
				await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", COM_SCRIPT], {
					LH_OFFICE_IN: path.resolve(input),
					LH_OFFICE_OUT: path.resolve(out),
				});
				if (!fs.existsSync(out)) throw new Error("Microsoft Office produced no PDF.");
			},
		};
	}
	return null;
}

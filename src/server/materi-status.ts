/**
 * Course-materials status for Settings → Course materials and the new-session
 * screen: is an index installed, what it holds per course, where the inbox
 * is, and the last ingest outcomes. Reads local files only; no network call.
 */

import fs from "node:fs";
import path from "node:path";

import type { MateriSourceEntry } from "../core/materi-ingest.ts";
import { primingEnabled } from "../core/settings-resolution.ts";
import { materiCourses, materiIndexDir } from "./materi-index.ts";
import { effectiveSettings } from "./stores.ts";
import { materiInboxDir, readSources, type IngestOutcome } from "./materi-ingest.ts";

export interface MateriCourseStatus {
	matkul: string;
	/** Indexed chunks (search rows). */
	chunks: number;
	/** Documents recorded for the course (duplicates excluded). */
	documents: number;
	/** Documents whose original pages can be shown in Priming. */
	withPages: number;
}

export interface MateriStatus {
	installed: boolean;
	/** Why the index is unavailable, when it is not installed. */
	problem?: string;
	courses: MateriCourseStatus[];
	inbox: string;
	/** The Priming switch (default on). Priming runs only when installed too. */
	priming: boolean;
	/** Newest first, at most 8. */
	recent: IngestOutcome[];
}

const RECENT = 8;

function recentIngests(): IngestOutcome[] {
	try {
		const lines = fs.readFileSync(path.join(materiIndexDir(), "ingest-log.jsonl"), "utf8").trim().split("\n");
		const out: IngestOutcome[] = [];
		for (let i = lines.length - 1; i >= 0 && out.length < RECENT; i--) {
			try {
				out.push(JSON.parse(lines[i] as string) as IngestOutcome);
			} catch {
				// a torn line is skipped, never fatal
			}
		}
		return out;
	} catch {
		return [];
	}
}

function hasPages(d: MateriSourceEntry): boolean {
	return Boolean(d.pdf && d.sha256);
}

export function materiStatus(): MateriStatus {
	let priming = true;
	try {
		priming = primingEnabled(effectiveSettings());
	} catch {
		// unreadable settings: report the default
	}
	const base = { inbox: materiInboxDir(), priming, recent: recentIngests() };
	let courses: { matkul: string; rows: number }[];
	try {
		courses = materiCourses();
	} catch (err) {
		return { ...base, installed: false, problem: err instanceof Error ? err.message : String(err), courses: [] };
	}
	const docs = readSources().docs.filter((d) => !d.duplicateOf);
	return {
		...base,
		installed: courses.length > 0,
		courses: courses.map((c) => {
			const mine = docs.filter((d) => d.matkul === c.matkul);
			return { matkul: c.matkul, chunks: c.rows, documents: mine.length, withPages: mine.filter(hasPages).length };
		}),
	};
}

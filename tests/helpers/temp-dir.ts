/** Temp dirs for tests that are gone when the test process ends, so a test
 *  run leaves nothing behind in the OS temp folder. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const made = new Set<string>();
const closers: (() => void)[] = [];
let hooked = false;

/** A fresh dir under the OS temp folder, removed when the process exits. */
export function tempDir(prefix: string): string {
	if (!hooked) {
		hooked = true;
		process.once("exit", sweep);
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	made.add(dir);
	return dir;
}

/** Runs before the dirs are removed: release open handles (SQLite) that
 *  would keep Windows from deleting a file. */
export function beforeSweep(close: () => void): void {
	closers.push(close);
}

function sweep(): void {
	for (const close of closers) {
		try {
			close();
		} catch {
			/* still try to remove the dirs */
		}
	}
	for (const dir of made) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* a locked file must not fail the run */
		}
	}
}

/**
 * Course-material search beyond the teacher: the prober and the practice
 * agent carry materi_search + materi_exact when an index is installed, and
 * never the page display (showing a page while measuring could hand over
 * the answer). No index, or a port that throws, leaves the registry intact.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools } from "../src/agent/tools.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import type { MateriSearchPort } from "../src/core/materi.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";

const port: MateriSearchPort = {
	courses: () => [{ matkul: "matkul-mr4062-manajemen-proyek", rows: 1 }],
	semantic: async () => [{ doc: "ch08.md", page: 21, matkul: "matkul-mr4062-manajemen-proyek", score: 0.9, text: "Backward pass: LF = min LS of successors." }],
	exact: async () => ({ hits: [], match: "all" }),
	page: async () => ({ png: new Uint8Array(), width: 1, height: 1, highlighted: [], blocks: [] }),
} as unknown as MateriSearchPort;

const proberCtx = {
	chatId: "c1",
	chatStore: { getChat: () => undefined, saveImageSnapshot: () => {} } as unknown as ChatStore,
	deliver: () => {},
	jobStore: {} as unknown as JobStore,
	spawn: () => {},
};
const practiceCtx = { chatId: "c1", chatStore: { getChat: () => ({ messages: [] }) } };

describe("materi tools for the prober and the practice agent", () => {
	it("prober: search + exact when an index is installed, no page display", () => {
		const names = Object.keys(createProberTools({ ...proberCtx, materi: () => port }));
		assert.ok(names.includes("materi_search"));
		assert.ok(names.includes("materi_exact"));
		assert.equal(names.includes("materi_page"), false);
		assert.equal(names.includes("materi_blocks"), false);
		assert.ok(names.includes("probe_done"), "probe_done stays");
	});
	it("prober: no index, or a broken port, adds nothing", () => {
		const bare = Object.keys(createProberTools(proberCtx)).sort();
		assert.deepEqual(Object.keys(createProberTools({ ...proberCtx, materi: () => null })).sort(), bare);
		const broken = () => {
			throw new Error("index unreadable");
		};
		assert.deepEqual(Object.keys(createProberTools({ ...proberCtx, materi: broken })).sort(), bare);
	});
	it("practice: search + exact, no page display; absent without an index", () => {
		const names = Object.keys(practiceTools({ ...practiceCtx, materi: () => port }));
		assert.ok(names.includes("materi_search") && names.includes("materi_exact"));
		assert.equal(names.includes("materi_page"), false);
		assert.equal(Object.keys(practiceTools({ ...practiceCtx, materi: () => null })).some((n) => n.startsWith("materi_")), false);
	});
	it("the prober's materi_search returns the course page", async () => {
		const tools = createProberTools({ ...proberCtx, materi: () => port });
		const res = await tools.materi_search!.execute("t", { query: "backward pass", course: "MR4062" });
		const text = res.content.map((c: { type: string; text?: string }) => c.text ?? "").join("");
		assert.match(text, /ch08\.md \| p\. 21/);
	});
});

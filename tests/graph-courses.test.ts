import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatCourses, courseLabel, courseOfSearchResult, courseVisibleIds, fileCourses, graphCourses } from "../src/core/graph-courses.ts";

const MR = "matkul-mr4062-manajemen-proyek";
const TI = "matkul-ti3105-sistem-produksi";
const hit = (course: string) => `[1] materi/${course}/Slide/a.pdf/markdown.md | p. 3 | ${course} | score 0.812\nisi halaman`;
const result = (toolName: string, text: string, extra: Record<string, unknown> = {}) => ({ role: "toolResult", toolName, content: [{ type: "text", text }], ...extra });

describe("graph courses — which matkul a source belongs to", () => {
	it("a scoped search names its course in the heading, with or without hits", () => {
		assert.equal(courseOfSearchResult("materi_search", `materi_search "cpm" in ${MR}: 8 pages, best first.\n\n${hit(MR)}`), MR);
		assert.equal(courseOfSearchResult("materi_search", `materi_search "cpm" in ${MR}: no pages found.`), MR);
		assert.equal(courseOfSearchResult("materi_exact", `materi_exact "forward pass" in ${MR}: 2 pages, best first.\n\n${hit(MR)}`), MR);
		assert.equal(
			courseOfSearchResult("materi_exact", `materi_exact slack float in ${MR} (no page has every word; pages with any of the words): 1 page, best first.\n\n${hit(MR)}`),
			MR,
		);
	});

	it("an unscoped search counts its best hit; errors and empty unscoped searches count nothing", () => {
		assert.equal(courseOfSearchResult("materi_search", `materi_search "eoq" in all courses: 2 pages, best first.\n\n${hit(TI)}\n\n${hit(MR)}`), TI);
		assert.equal(courseOfSearchResult("materi_search", `materi_search "eoq" in all courses: no pages found.`), undefined);
		assert.equal(courseOfSearchResult("materi_search", `materi_search: No course matches "X". Courses: ${MR}, ${TI}.`), undefined);
		assert.equal(courseOfSearchResult("materi_search", `materi_search failed: Voyage 500 for ${MR}`), undefined);
		assert.equal(courseOfSearchResult("materi_page", `Showing ${MR} p. 3`), undefined);
	});

	it("a query that itself contains ' in matkul-x:' does not win over the real scope", () => {
		assert.equal(courseOfSearchResult("materi_search", `materi_search "x in ${TI}: y" in ${MR}: no pages found.`), MR);
	});

	it("a chat belongs to every course with at least a quarter of its searches", () => {
		const msgs = [
			{ role: "user", content: `belajar ${TI}` },
			result("materi_search", `materi_search "a" in ${MR}: no pages found.`),
			result("materi_exact", `materi_exact a in ${MR}: no pages found.`),
			result("materi_search", `materi_search "b" in ${MR}: no pages found.`),
			result("materi_search", `materi_search "c" in all courses: 1 page, best first.\n\n${hit(TI)}`),
			result("materi_search", `materi_search "d" in ${TI}: no pages found.`, { isError: true }),
		];
		assert.deepEqual(chatCourses(msgs), [MR, TI]);
		const mostlyOne = [...msgs.slice(1, 4), ...msgs.slice(1, 4), msgs[4]];
		assert.deepEqual(chatCourses(mostlyOne), [MR], "one stray lookup out of seven does not split the chat");
		assert.deepEqual(chatCourses([{ role: "user", content: "halo" }, null, "x"]), []);
	});

	it("a notes file belongs to the course folder in its path", () => {
		assert.deepEqual(fileCourses(`C:\\data\\materi-files\\${TI}\\Slide\\a.pdf`), [TI]);
		assert.deepEqual(fileCourses(`notes/${MR}/bab8.md`), [MR]);
		assert.deepEqual(fileCourses("notes/pribadi.md"), []);
	});

	it("labels read as code + name", () => {
		assert.equal(courseLabel(MR), "MR4062 manajemen proyek");
		assert.equal(courseLabel("matkul-ti4005"), "TI4005");
	});

	it("the filter keeps a course's propositions and only implication nodes it fully anchors", () => {
		const snapshot = {
			nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "imp1" }, { id: "imp2" }],
			propositions: [{ id: "a" }, { id: "b" }, { id: "c" }],
			nodeSessions: { a: ["chat1"], b: ["chat1", "chat2"], c: ["chat2"] },
			sourceCourses: { chat1: [MR], chat2: [TI] },
			impLinks: [
				{ id: "imp1", premises: ["a"], conclusion: "b" },
				{ id: "imp2", premises: ["c"], conclusion: "a" },
			],
		};
		assert.deepEqual([...courseVisibleIds(snapshot, MR)].sort(), ["a", "b", "imp1"]);
		assert.deepEqual([...courseVisibleIds(snapshot, TI)].sort(), ["b", "c"]);
		assert.equal(courseVisibleIds(snapshot, null).size, 5);
		assert.deepEqual(graphCourses(snapshot), [
			{ course: MR, nodes: 2 },
			{ course: TI, nodes: 2 },
		]);
		assert.deepEqual(graphCourses({ ...snapshot, sourceCourses: undefined }), []);
	});
});

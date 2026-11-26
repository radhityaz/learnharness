import assert from "node:assert/strict";
import { tempDir } from "./helpers/temp-dir.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCanvas, loadImage } from "@napi-rs/canvas";

import { createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import { createMateriTools, formatBlocks } from "../src/agent/tools/materi.ts";
import type { MateriSearchPort } from "../src/core/materi.ts";
import { TOOL_TIMEOUT_OVERRIDES_MS } from "../src/agent/tool-execute.ts";
import { materiPage, ocrBudgetMs, type PageDeps } from "../src/server/materi-pages.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";

const OCR_RAW =
	"<｜ref｜>sub_title<｜/ref｜><｜box｜>[[100,50,900,150]]<｜/box｜> # Backward pass\n" +
	"<｜ref｜>text<｜/ref｜><｜box｜>[[100,300,600,400]]<｜/box｜> LS is the smallest LS of successors minus duration\n" +
	"<｜ref｜>image<｜/ref｜><｜box｜>[[100,500,900,950]]<｜/box｜>";

function whitePng(width = 400, height = 300): Buffer {
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}

function setup(): { restore: () => void; doc: string } {
	const root = tempDir("lh-pages-");
	const index = path.join(root, "materi-index");
	fs.mkdirSync(index, { recursive: true });
	const pdf = path.join(root, "ch08.pdf");
	fs.writeFileSync(pdf, "pdf");
	const doc = "materi/matkul-mr4062-manajemen-proyek/ch08.pdf/markdown.md";
	fs.writeFileSync(
		path.join(index, "sources.json"),
		JSON.stringify({
			version: 1,
			docs: [
				{ doc, matkul: "matkul-mr4062-manajemen-proyek", sha256: "a".repeat(64), pdf, origin: "legacy", pages: 82 },
				{ doc: "materi/no-pdf.md", matkul: "m", sha256: null, pdf: null, origin: "legacy" },
			],
		}),
	);
	const prev = process.env.LH_MATERI_INDEX_DIR;
	process.env.LH_MATERI_INDEX_DIR = index;
	return {
		doc,
		restore: () => {
			if (prev === undefined) delete process.env.LH_MATERI_INDEX_DIR;
			else process.env.LH_MATERI_INDEX_DIR = prev;
		},
	};
}

async function pixel(png: Uint8Array, x: number, y: number): Promise<[number, number, number]> {
	const image = await loadImage(Buffer.from(png));
	const canvas = createCanvas(image.width, image.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(image, 0, 0);
	const d = ctx.getImageData(x, y, 1, 1).data;
	return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
}

test("materiPage renders once, OCRs once, and boxes the chosen block in code", async () => {
	const env = setup();
	try {
		const calls = { render: 0, ocr: 0 };
		const deps: PageDeps = {
			render: async () => {
				calls.render++;
				return whitePng();
			},
			ocr: async () => {
				calls.ocr++;
				return OCR_RAW;
			},
		};
		const plain = await materiPage(env.doc, 21, [], deps);
		assert.equal(plain.blocks?.length, 3);
		assert.deepEqual(plain.highlighted, []);
		assert.deepEqual(await pixel(plain.png, 40, 90), [255, 255, 255]);

		const boxed = await materiPage(env.doc, 21, [2, 9], deps);
		assert.deepEqual(calls, { render: 1, ocr: 1 }, "page image and OCR are cached");
		assert.deepEqual(boxed.highlighted, [2]);
		assert.match(boxed.note ?? "", /Not highlighted: no block with a box has number 9/);
		// Block 2 spans y 300-400 of 1000 → 90-120 px; the box is drawn 6 px out (pad = 2 × 3 px line), so its top edge is y=84.
		const [r, g, b] = await pixel(boxed.png, 150, 84);
		assert.ok(r > 200 && g < 120 && b < 120, `expected the highlight red, got ${r},${g},${b}`);
		assert.deepEqual(await pixel(boxed.png, 300, 105), [255, 255, 255], "inside the box stays untouched");

		await assert.rejects(materiPage(env.doc, 83, [], deps), /outside/);
		await assert.rejects(materiPage("materi/no-pdf.md", 1, [], deps), /not available/);
		await assert.rejects(materiPage("nope", 1, [], deps), /Unknown document/);
	} finally {
		env.restore();
	}
});

test("materiPage still shows the page when OCR fails", async () => {
	const env = setup();
	try {
		const view = await materiPage(env.doc, 5, [1], {
			render: async () => whitePng(),
			ocr: async () => {
				throw new Error("No DeepSeek API key (DEEPSEEK_API_KEY) for OCR.");
			},
		});
		assert.equal(view.blocks, null);
		assert.match(view.note ?? "", /Blocks unavailable: No DeepSeek API key.*Not highlighted: the page has no blocks/);
	} finally {
		env.restore();
	}
});

test("a slow first OCR answers within its budget, keeps reading, and is paid for once", async () => {
	const env = setup();
	const budget = ocrBudgetMs.current;
	try {
		ocrBudgetMs.current = 40;
		let calls = 0;
		let finish: (raw: string) => void = () => {};
		const deps: PageDeps = {
			render: async () => whitePng(),
			ocr: () => {
				calls++;
				return new Promise<string>((resolve) => {
					finish = resolve;
				});
			},
		};
		const [first, retry] = await Promise.all([materiPage(env.doc, 7, [], deps), materiPage(env.doc, 7, [], deps)]);
		assert.equal(calls, 1, "the retry waits for the same OCR instead of paying again");
		for (const view of [first, retry]) {
			assert.equal(view.blocks, null);
			assert.match(view.note ?? "", /still being read/);
		}
		finish(OCR_RAW);
		await new Promise((r) => setTimeout(r, 20));
		const later = await materiPage(env.doc, 7, [], deps);
		assert.equal(calls, 1, "the finished OCR was cached");
		assert.ok((later.blocks?.length ?? 0) > 0);
		assert.equal(later.note, undefined);
	} finally {
		ocrBudgetMs.current = budget;
		env.restore();
	}
});

test("materi tools that OCR get a longer timeout than the page budget", () => {
	for (const tool of ["materi_blocks", "materi_page"]) {
		assert.ok((TOOL_TIMEOUT_OVERRIDES_MS[tool] ?? 0) > ocrBudgetMs.current + 10_000, tool);
	}
});

test("materi_page saves the image for the learner and gives the teacher only the block list", async () => {
	const saved: { id: string; width: number }[] = [];
	const port: MateriSearchPort = {
		courses: () => [{ matkul: "m", rows: 1 }],
		semantic: async () => [],
		exact: async () => ({ hits: [], match: "all" }),
		page: async (_doc, _page, highlight) => ({
			png: whitePng(),
			width: 400,
			height: 300,
			blocks: [
				{ label: "sub_title", box: [1, 2, 3, 4], text: "# Backward pass" },
				{ label: "image", box: [1, 2, 3, 4], text: "" },
			],
			highlighted: highlight ?? [],
		}),
	};
	const tools = createMateriTools(port, {
		chatId: "c",
		chatStore: { saveImageSnapshot: (_chat, id, image) => void saved.push({ id, width: image.width }) },
	});
	const page = tools.materi_page;
	assert.ok(page);
	const result = await page.execute("t", { doc: "d.md", page: 21, highlight: [1], caption: "Hitung mundur" });
	const text = result.content.map((c: { type: string; text?: string }) => c.text ?? "").join("");
	assert.equal(text, "Shown to the learner: d.md p. 21 with block 1 boxed.\nBlocks:\n1 [sub_title] # Backward pass\n2 [image] (figure, no text)");
	assert.equal(result.content.some((c: { type: string }) => c.type === "image"), false, "the page is not sent to the model");
	assert.equal(saved.length, 1);
	assert.deepEqual(result.details, {
		path: "d.md | p. 21",
		caption: "Hitung mundur",
		mimeType: "image/png",
		snapshotId: saved[0]?.id,
		width: 400,
		height: 300,
	});

	const failing = createMateriTools({ ...port, page: async () => { throw new Error("Unknown document"); } }, {
		chatId: "c",
		chatStore: { saveImageSnapshot: () => {} },
	});
	const failed = await failing.materi_page?.execute("t", { doc: "x", page: 1 });
	assert.match(String(failed?.content.map((c) => ("text" in c ? c.text : "")).join("")), /^materi_page failed: Unknown document/);
	assert.equal(formatBlocks({ png: new Uint8Array(), width: 1, height: 1, blocks: null, highlighted: [] }), "No blocks for this page.");
});

test("materi_blocks reads the block list without showing anything; oneBlock refuses multi-block boxes", async () => {
	const saved: string[] = [];
	const calls: number[][] = [];
	const port: MateriSearchPort = {
		courses: () => [{ matkul: "m", rows: 1 }],
		semantic: async () => [],
		exact: async () => ({ hits: [], match: "all" }),
		page: async (_doc, _page, highlight) => {
			calls.push(highlight ?? []);
			return {
				png: whitePng(),
				width: 400,
				height: 300,
				blocks: [
					{ label: "sub_title", box: [1, 2, 3, 4], text: "# Backward pass" },
					{ label: "text", box: [1, 2, 3, 4], text: "LS = LF - t" },
				],
				highlighted: highlight ?? [],
			};
		},
	};
	const display = { chatId: "c", chatStore: { saveImageSnapshot: (_chat: string, id: string) => void saved.push(id) } };
	const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

	const primer = createMateriTools(port, display, { oneBlock: true });
	const look = await primer.materi_blocks?.execute("t", { doc: "d.md", page: 4 });
	assert.ok(look);
	assert.equal(textOf(look), "Not shown to the learner (read only): d.md p. 4.\nBlocks:\n1 [sub_title] # Backward pass\n2 [text] LS = LF - t");
	assert.equal((look.details as { snapshotId?: string } | null)?.snapshotId, undefined, "no image card for a look");
	assert.equal(saved.length, 0, "nothing saved for the learner");

	const refused = await primer.materi_page?.execute("t", { doc: "d.md", page: 4, highlight: [1, 2] });
	assert.ok(refused);
	assert.match(textOf(refused), /^materi_page refused: box one block per call \(got 2: 1, 2\)\. Nothing was shown\./);
	assert.equal(saved.length, 0, "a refused call shows nothing");
	assert.deepEqual(calls, [[]], "a refused call does not render the page");

	const one = await primer.materi_page?.execute("t", { doc: "d.md", page: 4, highlight: [2, 2] });
	assert.match(textOf(one!), /^Shown to the learner: d\.md p\. 4 with block 2 boxed\./, "a repeated number is one block");
	assert.match(textOf(one!), /write your explanation of block 2 to him as visible reply text/, "the primer is told to explain in visible text");
	assert.equal(saved.length, 1);

	const teacher = createMateriTools(port, display);
	const many = await teacher.materi_page?.execute("t", { doc: "d.md", page: 4, highlight: [1, 2] });
	assert.match(textOf(many!), /^Shown to the learner: d\.md p\. 4 with block 1, 2 boxed\./, "the teacher may box several");
	assert.doesNotMatch(textOf(many!), /visible reply text/, "the teacher's result is unchanged");
});

test("teacher registry: materi_page comes with the materi tools when pages can be shown", () => {
	const base: TeacherToolContext = { chatId: "materi-pages-test", chatStore, jobStore, spawn: () => {} };
	const port: MateriSearchPort = {
		courses: () => [{ matkul: "m", rows: 1 }],
		semantic: async () => [],
		exact: async () => ({ hits: [], match: "all" }),
	};
	assert.ok(!("materi_page" in createTeacherTools({ ...base, materi: () => port })), "no page renderer, no tool");
	const withPages = createTeacherTools({ ...base, materi: () => ({ ...port, page: async () => { throw new Error("x"); } }) });
	assert.ok("materi_page" in withPages);
});

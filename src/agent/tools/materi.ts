import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import type { MateriCourse, MateriHit, MateriPageView, MateriSearchPort } from "../../core/materi.ts";
import type { ShowImageDetails } from "../../core/contracts.ts";
import type { ChatStore } from "../../core/ports.ts";

/**
 * Course-material search tools for the teacher (materi index):
 *
 *   materi_search(query, course?, limit?)  meaning search (cross-language)
 *   materi_exact(query, course?, limit?)   literal words (codes, names, symbols)
 *   materi_page(doc, page, highlight?)     Priming: show the original page to the
 *                                          learner, boxes drawn around chosen blocks
 *
 * Two tools, never one merged list: merging literal hits into the semantic
 * ranking lowered accuracy in the retrieval test. The port is injected
 * (import law: agent code depends on the core port, never server code).
 * Neither tool calls a chat model.
 *
 * Tool contract (the web.ts law): never throw into the agent loop; every
 * failure returns a clear string the teacher can act on.
 */

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
/** Characters per hit returned to the teacher (keeps a 5-hit result near 1k tokens). */
const TEXT_CAP = 800;

const input = Type.Object({
	query: Type.String({ description: "What to look for, written as a normal question or phrase." }),
	course: Type.Optional(
		Type.String({ description: "Course code or id to search in (e.g. MR4062). Omit to search every course." }),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Pages to return (default ${DEFAULT_LIMIT}).` }),
	),
});

/** Resolves a course code ("MR4062", "mr4062", or the full id) to a shard id. */
export function resolveCourse(courses: MateriCourse[], course: string | undefined): string | undefined | Error {
	const wanted = course?.trim().toLowerCase();
	if (!wanted) return undefined;
	const exact = courses.find((c) => c.matkul.toLowerCase() === wanted);
	if (exact) return exact.matkul;
	const partial = courses.filter((c) => c.matkul.toLowerCase().includes(wanted));
	if (partial.length === 1) return partial[0]?.matkul;
	const list = courses.map((c) => c.matkul).join(", ");
	return new Error(
		partial.length > 1
			? `Course "${course}" matches more than one course (${partial.map((c) => c.matkul).join(", ")}). Use the full id.`
			: `No course matches "${course}". Courses: ${list}.`,
	);
}

export function formatHits(hits: MateriHit[], heading: string): string {
	if (hits.length === 0) return `${heading}: no pages found.`;
	const lines = [`${heading}: ${hits.length} page${hits.length === 1 ? "" : "s"}, best first.`];
	hits.forEach((h, i) => {
		const page = h.page === null ? "no page" : `p. ${h.page}`;
		lines.push("", `[${i + 1}] ${h.doc} | ${page} | ${h.matkul} | score ${h.score.toFixed(3)}`, h.text.trim());
	});
	return lines.join("\n");
}

function errorText(tool: string, err: unknown): string {
	return `${tool} failed: ${err instanceof Error ? err.message : String(err)}`;
}

const pageInput = Type.Object({
	doc: Type.String({ minLength: 1, description: "Document path exactly as materi_search or materi_exact printed it." }),
	page: Type.Integer({ minimum: 1, description: "Page number." }),
	highlight: Type.Optional(
		Type.Array(Type.Integer({ minimum: 1 }), {
			maxItems: 6,
			description: "Block numbers to box on the page, from this page's block list. Omit to show the page plain.",
		}),
	),
	caption: Type.Optional(Type.String({ description: "One short line shown under the page." })),
});

/** Characters of each block shown in the block list. */
const BLOCK_TEXT_CAP = 160;

export function formatBlocks(view: MateriPageView): string {
	if (!view.blocks || view.blocks.length === 0) return "No blocks for this page.";
	return view.blocks
		.map((b, i) => {
			const text = b.text.replace(/\s+/g, " ").trim();
			const shown = text ? (text.length > BLOCK_TEXT_CAP ? `${text.slice(0, BLOCK_TEXT_CAP)}…` : text) : "(figure, no text)";
			return `${i + 1} [${b.label}]${b.box ? "" : " (no box)"} ${shown}`;
		})
		.join("\n");
}

export interface MateriDisplay {
	chatId: string;
	chatStore: Pick<ChatStore, "saveImageSnapshot">;
}

function pageTool(port: MateriSearchPort & Required<Pick<MateriSearchPort, "page">>, display: MateriDisplay): AgentTool<any> {
	return {
		name: "materi_page",
		label: "materi_page",
		description:
			"Show the learner an original page from their course materials (slide or textbook page) and, optionally, " +
			"box specific blocks on it. Use it to teach from the source before any quiz: show the page, point at one block, " +
			"explain it, then box the next. The result lists the page's numbered blocks (title, text, equation, table, image) " +
			"read by OCR; pass their numbers in highlight on the next call. The image is not sent back to you. " +
			"Boxes surround whole blocks; a figure is one block, so parts inside a diagram cannot be boxed separately.",
		parameters: pageInput,
		execute: serverExecute("materi_page", pageInput, async ({ doc, page, highlight, caption }): Promise<ImageFileResult | string> => {
			let view: MateriPageView;
			try {
				view = await port.page(doc, page, highlight ?? []);
			} catch (err) {
				return `materi_page failed: ${err instanceof Error ? err.message : String(err)}`;
			}
			const bytes = Buffer.from(view.png);
			const snapshotId = createHash("sha256").update(bytes).digest("hex");
			display.chatStore.saveImageSnapshot(display.chatId, snapshotId, {
				mimeType: "image/png",
				data: bytes.toString("base64"),
				width: view.width,
				height: view.height,
			});
			const trimmed = caption?.trim();
			const details: ShowImageDetails = {
				path: `${doc} | p. ${page}`,
				...(trimmed ? { caption: trimmed } : {}),
				mimeType: "image/png",
				snapshotId,
				width: view.width,
				height: view.height,
			};
			const boxed = view.highlighted.length > 0 ? ` with block ${view.highlighted.join(", ")} boxed` : "";
			const lines = [`Shown to the learner: ${doc} p. ${page}${boxed}.`];
			if (view.note) lines.push(view.note);
			lines.push("Blocks:", formatBlocks(view));
			return { text: lines.join("\n"), details };
		}),
	};
}

export function createMateriTools(port: MateriSearchPort, display?: MateriDisplay): Record<string, AgentTool<any>> {
	const courses = port.courses();
	const courseList = courses.map((c) => c.matkul).join(", ");
	const page = port.page;
	return {
		...(page && display ? { materi_page: pageTool({ ...port, page }, display) } : {}),
		materi_search: {
			name: "materi_search",
			label: "materi_search",
			description:
				"Search the learner's course materials (slides, textbooks) by meaning. Works across languages: " +
				"ask in Indonesian, find English pages. Returns pages with document path, page number, and an excerpt. " +
				"Pass course whenever the topic belongs to one course; it is more accurate. " +
				"For an exact code, name, symbol, or term, use materi_exact instead. " +
				`Courses: ${courseList}.`,
			parameters: input,
			execute: serverExecute("materi_search", input, async ({ query, course, limit }, { signal }): Promise<string> => {
				const matkul = resolveCourse(courses, course);
				if (matkul instanceof Error) return `materi_search: ${matkul.message}`;
				try {
					const hits = await port.semantic(query, {
						matkul,
						limit: limit ?? DEFAULT_LIMIT,
						textCap: TEXT_CAP,
						signal,
					});
					return formatHits(hits, `materi_search "${query}" in ${matkul ?? "all courses"}`);
				} catch (err) {
					return errorText("materi_search", err);
				}
			}),
		},

		materi_exact: {
			name: "materi_exact",
			label: "materi_exact",
			description:
				"Find pages in the learner's course materials that contain the exact words given " +
				'(codes, names, symbols, formulas, terms). Put a multi-word term in double quotes, e.g. "free slack". ' +
				"Words match as written (case and accents ignored); synonyms and other languages do not match, " +
				"so use materi_search for meaning. Excerpts mark matches with [brackets]. " +
				`Courses: ${courseList}.`,
			parameters: input,
			execute: serverExecute("materi_exact", input, async ({ query, course, limit }, { signal }): Promise<string> => {
				const matkul = resolveCourse(courses, course);
				if (matkul instanceof Error) return `materi_exact: ${matkul.message}`;
				try {
					const result = await port.exact(query, { matkul, limit: limit ?? DEFAULT_LIMIT, textCap: TEXT_CAP, signal });
					const where = matkul ?? "all courses";
					const heading =
						result.match === "all"
							? `materi_exact ${query} in ${where}`
							: `materi_exact ${query} in ${where} (no page has every word; pages with any of the words)`;
					return formatHits(result.hits, heading);
				} catch (err) {
					return errorText("materi_exact", err);
				}
			}),
		},
	};
}

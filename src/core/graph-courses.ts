/**
 * Which course (matkul) a graph source belongs to, read from what is
 * already stored — no model call, no extra state.
 *
 *   chat        the materi_search / materi_exact results in its messages:
 *               a scoped search names its course in the heading
 *               ("… in matkul-mr4062-…: 8 pages"); an unscoped one counts
 *               the course of its best hit. A chat belongs to every course
 *               that got at least a quarter of its searches, so a session
 *               that mainly studied one course is not split by one stray
 *               lookup.
 *   notes file  a path segment that is a course id ("…/materi-files/
 *               matkul-ti3105-…/x.pdf").
 *
 * Course ids look like "matkul-<code>-<name>". A source with no evidence
 * has no course; the graph filter then leaves it out rather than guessing.
 */

const COURSE_ID = /^matkul-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOPED = / in (matkul-[a-z0-9]+(?:-[a-z0-9]+)*)(?::| \()/;
const HIT = /\| (matkul-[a-z0-9]+(?:-[a-z0-9]+)*) \| score /;
const SEARCH_TOOLS = new Set(["materi_search", "materi_exact"]);
/** A course needs this share of a chat's searches to count. */
export const COURSE_SHARE = 0.25;

function resultText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("\n");
}

/** The course one search result was about, or undefined (an error, or no hits
 *  in an unscoped search). */
export function courseOfSearchResult(tool: string, text: string): string | undefined {
	// Success headings start "<tool> <query> in …"; errors are "<tool>: …" or
	// "<tool> failed: …" and say nothing about what was studied.
	if (!SEARCH_TOOLS.has(tool) || !text.startsWith(`${tool} `) || text.startsWith(`${tool} failed: `)) return undefined;
	const heading = text.split("\n", 1)[0] ?? "";
	// The query sits in quotes before " in …"; take the LAST match on the line
	// so a query that itself contains " in matkul-x:" cannot win.
	const scoped = [...heading.matchAll(new RegExp(SCOPED.source, "g"))].at(-1)?.[1];
	if (scoped) return scoped;
	return HIT.exec(text)?.[1];
}

export function chatCourses(messages: readonly unknown[] | undefined): string[] {
	if (!Array.isArray(messages)) return [];
	const counts = new Map<string, number>();
	let total = 0;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const m = message as Record<string, unknown>;
		if (m.role !== "toolResult" || typeof m.toolName !== "string" || m.isError === true) continue;
		const course = courseOfSearchResult(m.toolName, resultText(m));
		if (!course) continue;
		counts.set(course, (counts.get(course) ?? 0) + 1);
		total++;
	}
	return [...counts]
		.filter(([, n]) => n >= Math.max(1, total * COURSE_SHARE))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([course]) => course);
}

export function fileCourses(filePath: string): string[] {
	const found = filePath.split(/[\\/]+/).map((s) => s.toLowerCase()).filter((s) => COURSE_ID.test(s));
	return [...new Set(found)].slice(0, 1);
}

/** "matkul-mr4062-manajemen-proyek" → "MR4062 manajemen proyek". */
export function courseLabel(course: string): string {
	const [, code, ...rest] = course.split("-");
	if (!code) return course;
	return [code.toUpperCase(), rest.join(" ")].filter(Boolean).join(" ");
}

/** The node ids a course filter keeps. A proposition stays when one of its
 *  sources belongs to the course; an implication node stays when its
 *  conclusion and at least one premise stay, so no arrow is left dangling.
 *  `course === null` keeps everything. */
export function courseVisibleIds(
	snapshot: {
		nodes: readonly { id: string }[];
		nodeSessions: Readonly<Record<string, readonly string[]>>;
		sourceCourses?: Readonly<Record<string, readonly string[]>>;
		impLinks: readonly { id: string; premises: readonly string[]; conclusion: string }[];
	},
	course: string | null,
): Set<string> {
	const ids = new Set<string>();
	if (course === null) {
		for (const node of snapshot.nodes) ids.add(node.id);
		return ids;
	}
	const of = snapshot.sourceCourses ?? {};
	for (const [nodeId, sources] of Object.entries(snapshot.nodeSessions)) {
		if (sources.some((s) => of[s]?.includes(course))) ids.add(nodeId);
	}
	for (const link of snapshot.impLinks) {
		if (ids.has(link.conclusion) && link.premises.some((p) => ids.has(p))) ids.add(link.id);
	}
	return ids;
}

/** Courses present in the graph with their proposition counts, largest first. */
export function graphCourses(snapshot: {
	propositions: readonly { id: string }[];
	nodeSessions: Readonly<Record<string, readonly string[]>>;
	sourceCourses?: Readonly<Record<string, readonly string[]>>;
}): { course: string; nodes: number }[] {
	const of = snapshot.sourceCourses ?? {};
	const counts = new Map<string, number>();
	for (const node of snapshot.propositions) {
		const courses = new Set((snapshot.nodeSessions[node.id] ?? []).flatMap((s) => of[s] ?? []));
		for (const c of courses) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	return [...counts].map(([course, nodes]) => ({ course, nodes })).sort((a, b) => b.nodes - a.nodes || a.course.localeCompare(b.course));
}

/**
 * Priming — the optional phase before the probe: the primer registry and
 * prompt, the prime_done seam tool, the record gate (primingOpen), and both
 * phase folds (view parts and native records).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { primeDoneTool } from "../src/agent/tools/prime.ts";
import { createPrimerTools } from "../src/agent/tools.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import type { MateriSearchPort } from "../src/core/materi.ts";
import type { SteerMessage } from "../src/core/contracts.ts";
import { PRIME_HANDOFF_TEXT, primeDoneInputSchema } from "../src/core/contracts.ts";
import { Value } from "typebox/value";
import { hasPrimeDone, primingOpen, type LhMessage } from "../src/core/native-messages.ts";
import { phaseAt3, phaseAt3Lh, phaseTimeline } from "../src/core/phases.ts";
import type { LhViewMessage } from "../src/core/view.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

fs.mkdirSync(PATHS.data, { recursive: true });
const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* best effort */
		}
	}
});
function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

let seq = 0;
function call(name: string, args: unknown = {}, stopReason = "toolUse"): LhMessage {
	seq++;
	return {
		id: `a${seq}`,
		role: "assistant",
		content: [{ type: "toolCall", id: `call_${name}_${seq}`, name, arguments: args as never }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason,
		timestamp: Date.now(),
	} as never;
}
function text(t: string): LhMessage {
	seq++;
	return { ...(call("x") as object), id: `a${seq}`, content: [{ type: "text", text: t }], stopReason: "stop" } as never;
}
function resultFor(m: LhMessage, ok = true): LhMessage {
	const block = (m as { content: Array<{ id: string; name: string }> }).content[0]!;
	return {
		id: `r_${block.id}`,
		role: "toolResult",
		toolCallId: block.id,
		toolName: block.name,
		content: [{ type: "text", text: "ok" }],
		details: { ok },
		isError: false,
		timestamp: Date.now(),
	} as never;
}
const SUMMARY = { pages: [{ doc: "d.pdf", page: 3 }], summary: "Covered AON and float." };

describe("primingOpen: the record decides whether the primer runs", () => {
	it("a fresh session is primed only when priming is offered", () => {
		assert.equal(primingOpen([], true), true);
		assert.equal(primingOpen([], false), false);
	});
	it("stays open through materi activity, closes at a concluded prime_done", () => {
		const search = call("materi_search", { query: "aon" });
		const done = call("prime_done", SUMMARY);
		assert.equal(primingOpen([search, resultFor(search)], true), true);
		assert.equal(primingOpen([search, resultFor(search), done], true), true, "a bare call keeps it open");
		assert.equal(primingOpen([search, resultFor(search), done, resultFor(done)], true), false);
		assert.equal(primingOpen([search, resultFor(search), done, resultFor(done, false)], true), true, "a refusal keeps it open");
	});
	it("never reopens a session that is probing or was never primed", () => {
		assert.equal(primingOpen([call("probe", { question: "q" })], true), false);
		assert.equal(primingOpen([call("materi_search"), call("recall")], true), false);
		assert.equal(primingOpen([text("What do you want to learn?")], true), false, "an older prober turn without materi calls");
		assert.equal(primingOpen([call("ask_user_question")], true), false);
	});
	it("ignores aborted turns", () => {
		assert.equal(primingOpen([text("partial") as never], true), false);
		assert.equal(primingOpen([{ ...(text("partial") as object), stopReason: "aborted" } as never], true), true);
	});
});

describe("prime_done: the prime→probe seam", () => {
	it("queues one handoff wake with the probe stage and fires once", async () => {
		const chatId = newChat("Prime: ok");
		const delivered: SteerMessage[] = [];
		const tool = primeDoneTool({ chatId, chatStore, deliver: (s) => delivered.push(s) }).prime_done!;
		const res = await tool.execute("t1", SUMMARY);
		assert.equal((res.details as { ok: boolean }).ok, true);
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0]!.id, `steer_prime_${chatId}`);
		assert.equal(delivered[0]!.customType, "probe-handoff");
		assert.equal(delivered[0]!.content, PRIME_HANDOFF_TEXT);
		assert.equal((delivered[0]!.details as { stage: string }).stage, "probe");

		const done = call("prime_done", SUMMARY);
		chatStore.saveMessages(chatId, [done, resultFor(done)]);
		assert.equal(hasPrimeDone(chatStore.getChat(chatId)!.messages), true);
		const again = await tool.execute("t2", SUMMARY);
		assert.equal((again.details as { ok: boolean }).ok, false);
		assert.equal(delivered.length, 1, "nothing queued on refusal");
	});
	it("refuses while a question is open", async () => {
		const chatId = newChat("Prime: open question");
		chatStore.saveMessages(chatId, [call("ask_user_question", { questions: [{ question: "Which chapter?" }] })]);
		const delivered: SteerMessage[] = [];
		const res = await primeDoneTool({ chatId, chatStore, deliver: (s) => delivered.push(s) }).prime_done!.execute("t", SUMMARY);
		assert.equal((res.details as { ok: boolean }).ok, false);
		assert.match((res.details as { error: string }).error, /question is still open/i);
		assert.equal(delivered.length, 0);
	});
	it("its schema requires a summary (the agent loop validates before execute)", () => {
		assert.equal(Value.Check(primeDoneInputSchema, SUMMARY), true);
		assert.equal(Value.Check(primeDoneInputSchema, { pages: [] }), false);
		assert.equal(Value.Check(primeDoneInputSchema, { pages: [], summary: "" }), false);
	});
});

describe("the primer registry and prompt", () => {
	const port: MateriSearchPort = {
		courses: () => [{ matkul: "matkul-mr4062-manajemen-proyek", rows: 1 }],
		semantic: async () => [],
		exact: async () => ({ hits: [], match: "all" }),
		page: async () => ({ png: new Uint8Array(), width: 1, height: 1, highlighted: [], blocks: [] }),
	};
	it("carries the materi tools, ask, and prime_done, and no graded question tool", () => {
		const names = Object.keys(createPrimerTools({ chatId: "p", chatStore, deliver: () => {}, materi: () => port })).sort();
		assert.deepEqual(names, ["ask_user_question", "materi_blocks", "materi_exact", "materi_page", "materi_search", "prime_done"]);
	});
	it("the primer's materi_page boxes one block per call", async () => {
		const tools = createPrimerTools({ chatId: "p", chatStore, deliver: () => {}, materi: () => port });
		const res = await tools.materi_page?.execute("t", { doc: "d.md", page: 1, highlight: [1, 3] });
		const text = res?.content.map((c: { type: string; text?: string }) => c.text ?? "").join("");
		assert.match(String(text), /^materi_page refused: box one block per call/);
	});
	it("composes the priming doctrine without the quiz mechanics", () => {
		const prompt = composeInstructions("primer");
		assert.match(prompt, /Priming — teach from his own course pages/);
		assert.doesNotMatch(prompt, /## The question tools/);
		assert.doesNotMatch(prompt, /# The probe\n/);
	});
});

describe("phase folds with priming", () => {
	const v = (type: string, state?: string, output?: unknown): LhViewMessage =>
		({ id: `v${++seq}`, role: "assistant", parts: [{ type, ...(state ? { state } : {}), ...(output ? { output } : {}) }] }) as never;
	it("view fold: prime from the first materi call, probe after a concluded prime_done", () => {
		const msgs = [
			v("tool-materi_search", "output-available"),
			v("tool-materi_page", "output-available"),
			v("tool-prime_done", "output-available", { ok: true }),
			v("tool-probe", "input-available"),
		];
		assert.deepEqual(phaseTimeline(msgs), ["prime", "prime", "probe", "probe"]);
		assert.equal(phaseAt3(msgs.slice(0, 2)), "prime");
	});
	it("view fold: a refused prime_done keeps priming; teacher materi calls never re-enter it", () => {
		assert.equal(phaseAt3([v("tool-materi_search", "output-available"), v("tool-prime_done", "output-available", { ok: false })]), "prime");
		const late = [v("tool-probe", "input-available"), v("tool-materi_search", "output-available")];
		assert.equal(phaseAt3(late), "probe");
		assert.equal(phaseAt3([]), "probe");
	});
	it("native fold: prime→probe at the clean prime_done result, probe→plan after", () => {
		const search = call("materi_search");
		const done = call("prime_done", SUMMARY);
		const probeDone = call("probe_done", {});
		const recs = [search, resultFor(search), done, resultFor(done), call("probe", {}), probeDone, resultFor(probeDone)];
		assert.equal(phaseAt3Lh(recs, 1), "prime");
		assert.equal(phaseAt3Lh(recs, 2), "prime", "a bare prime_done call keeps priming");
		assert.equal(phaseAt3Lh(recs, 3), "probe");
		assert.equal(phaseAt3Lh(recs, 5), "probe");
		assert.equal(phaseAt3Lh(recs), "plan");
		assert.equal(phaseAt3Lh([search, resultFor(search), done, resultFor(done, false)]), "prime");
		assert.equal(phaseAt3Lh([call("ask_user_question")]), "probe", "an unprimed session opens in probe");
	});
});

/**
 * Priming through the real chat handler (scripted model): with a materi
 * index installed, a fresh teach session builds the PRIMER; prime_done
 * queues the handoff wake, and the wake turn builds the PROBER. Without an
 * index the same session builds the prober from turn 1.
 */
import assert from "node:assert/strict";
import { beforeSweep, tempDir } from "./helpers/temp-dir.ts";
import { closeFts } from "../src/server/materi-index.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createPrimerAgent, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatInput, handleChatRequest } from "../src/server/chat-handler.ts";
import { deliverJobResult, setTurnRunner } from "../src/server/jobs.ts";
import { buildMateriFts, materiSearchPort } from "../src/server/materi-index.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { chatStore } from "../src/store/chats.ts";
import { phaseAt3Lh } from "../src/core/phases.ts";
import { EMBED_MODEL } from "../src/core/pdf-index.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { PATHS } from "../config.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

// Close the cached FTS handle before the temp index dirs are removed.
beforeSweep(closeFts);

const createdChats: string[] = [];
let indexDir = "";
const prevIndex = process.env.LH_MATERI_INDEX_DIR;

function writeIndex(dir: string): void {
	const matkul = "matkul-mr4062-manajemen-proyek";
	const rows: [string, number, string][] = [
		["ch08.pdf", 22, "Total slack is LS minus ES. Free slack is smaller."],
		["ch08.pdf", 26, "Activity on node: each activity is a box."],
	];
	fs.writeFileSync(
		path.join(dir, "manifest.json"),
		JSON.stringify({ version: 1, model: EMBED_MODEL, dim: 2, rows: rows.length, shards: [{ matkul, rows: rows.length }] }),
	);
	const texts: Buffer[] = [];
	const refs: [string, number, number, number][] = [];
	let offset = 0;
	for (const [doc, page, text] of rows) {
		const b = Buffer.from(text, "utf8");
		refs.push([doc, page, offset, b.length]);
		texts.push(b);
		offset += b.length;
	}
	fs.writeFileSync(path.join(dir, `${matkul}.texts.bin`), Buffer.concat(texts));
	fs.writeFileSync(path.join(dir, `${matkul}.rows.json`), JSON.stringify(refs));
	fs.writeFileSync(path.join(dir, `${matkul}.f32`), Buffer.from(new Float32Array(rows.length * 2).fill(Math.SQRT1_2).buffer));
}

before(() => {
	indexDir = tempDir("lh-priming-");
	writeIndex(indexDir);
	process.env.LH_MATERI_INDEX_DIR = indexDir;
	buildMateriFts();
});
after(() => {
	if (prevIndex === undefined) delete process.env.LH_MATERI_INDEX_DIR;
	else process.env.LH_MATERI_INDEX_DIR = prevIndex;
	try {
		fs.rmSync(indexDir, { recursive: true, force: true });
	} catch {
		/* Windows keeps the FTS file locked until exit; the temp dir is harmless */
	}
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* gone */
		}
	}
});

function engineOf(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function drain(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const { chatId } = (await req.clone().json()) as { chatId: string };
	const ack = await handleChatRequest(req, factory);
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const tick = () => (cond() ? resolve() : Date.now() - t0 > ms ? reject(new Error("timeout")) : setTimeout(tick, 25));
		tick();
	});
}

function newChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	createdChats.push(chat.id);
	return chat;
}

describe("priming flow (scripted model)", () => {
	it("primer first, prime_done hands off, the wake builds the prober", async () => {
		const chat = newChat("Priming: flow");
		const builds: string[] = [];
		let primerTools: string[] = [];
		const primerEngine = engineOf([
			() => fauxAssistantMessage([fauxToolCall("materi_exact", { query: "slack", course: "MR4062" }, { id: "c-search" })], { stopReason: "toolUse" }),
			(context) => {
				const last = context.messages.at(-1) as { content?: Array<{ text?: string }> };
				assert.match(last.content?.[0]?.text ?? "", /ch08\.pdf \| p\. 22/, "the primer sees the real search result");
				return fauxAssistantMessage([fauxText("Slack is LS minus ES. Tell me when you are ready.")]);
			},
			() => fauxAssistantMessage([fauxToolCall("prime_done", { pages: [{ doc: "ch08.pdf", page: 22 }], summary: "Covered total and free slack." }, { id: "c-done" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Over to the probe.")]),
		]);
		const proberEngine = engineOf([() => fauxAssistantMessage([fauxText("Let's see what you hold now.")])]);
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) => {
			if (opts.priming) {
				builds.push("primer");
				const agent = createPrimerAgent(
					{ chatId: chat.id, chatStore, deliver: (s) => void deliverJobResult(s), materi: materiSearchPort },
					{ engine: primerEngine, messages: opts.messages },
				);
				primerTools = agent.state.tools.map((t: { name: string }) => t.name).sort();
				return agent;
			}
			builds.push(opts.teaching ? "teacher" : "prober");
			return createTeacherAgent(undefined, { engine: proberEngine, messages: opts.messages });
		};
		setTurnRunner(async (chatId, input) => {
			const res = await handleChatInput(chatId, input, factory);
			await res.arrayBuffer().catch(() => undefined);
			return res.status;
		});

		await drain(post(chat.id, { type: "text", text: "ajarin slack MR4062" }), factory);
		assert.deepEqual(builds, ["primer"]);
		assert.ok(primerTools.includes("prime_done") && primerTools.includes("materi_exact"));
		assert.ok(!primerTools.includes("probe") && !primerTools.includes("quiz"), "the primer cannot quiz");
		assert.equal(phaseAt3Lh(chatStore.getChat(chat.id)!.messages), "prime");

		await drain(post(chat.id, { type: "text", text: "siap" }), factory);
		assert.equal(builds[1], "primer", "still priming until prime_done concludes");

		const marker = `steer_prime_${chat.id}`;
		await waitFor(() => chatStore.getChat(chat.id)!.messages.some((m) => m.id === marker) && !isTurnRunning(chat.id));
		await waitFor(() => builds.length >= 3 && !isTurnRunning(chat.id));
		assert.equal(builds[2], "prober", "the handoff wake builds the prober");
		const record = chatStore.getChat(chat.id)!;
		assert.equal(phaseAt3Lh(record.messages), "probe");
		assert.ok(record.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("what you hold now")));
	});

	it("no index installed: the session probes from turn 1", async () => {
		const chat = newChat("Priming: no index");
		const saved = process.env.LH_MATERI_INDEX_DIR;
		process.env.LH_MATERI_INDEX_DIR = path.join(indexDir, "missing");
		try {
			const builds: string[] = [];
			const engine = engineOf([() => fauxAssistantMessage([fauxText("What do you want to learn?")])]);
			await drain(post(chat.id, { type: "text", text: "hi" }), (opts) => {
				builds.push(opts.priming ? "primer" : "prober");
				return createTeacherAgent(undefined, { engine, messages: opts.messages });
			});
			assert.deepEqual(builds, ["prober"]);
		} finally {
			process.env.LH_MATERI_INDEX_DIR = saved;
		}
	});
});

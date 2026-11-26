import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { primeDoneInputSchema, PRIME_DONE_ACK_TEXT } from "../../core/contracts.ts";
import { hasPrimeDone, hasUnresolvedQuestion, newPrimeHandoffMessage } from "../../core/native-messages.ts";
import type { ChatStore } from "../../core/ports.ts";
import type { SteerMessage } from "../../core/contracts.ts";

/** What the prime_done tool closes over. */
export interface PrimeDoneContext {
	chatId: string;
	chatStore: ChatStore;
	/** Queue the handoff wake (the wake pipeline — src/server/jobs.ts). */
	deliver: (steer: SteerMessage) => void;
}

/**
 * prime_done — the prime→probe seam. SERVER-SIDE, refused while a question
 * is open and after priming already concluded. On success it queues the
 * handoff wake, so the prober's first turn starts as soon as the primer's
 * turn ends; from the matching result on, every request builds the prober.
 * The summary lives once, as the call's arguments; the agent sees a fixed ack.
 */
export function primeDoneTool(ctx: PrimeDoneContext): Record<string, AgentTool<any>> {
	return {
		prime_done: {
			name: "prime_done",
			label: "prime_done",
			description:
				"End the priming phase and hand the session to the probe. Call it ONCE: after the learner has said they " +
				"are ready for questions, or right away (skipped: true) when the course materials hold nothing for this " +
				"topic or the learner asks to skip. Refused while a question is still open. After it succeeds, say one " +
				"short closing sentence and end your turn.",
			parameters: primeDoneInputSchema,
			execute: serverExecute("prime_done", primeDoneInputSchema, async () => {
				const record = ctx.chatStore.getChat(ctx.chatId);
				if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
				if (hasUnresolvedQuestion(record.messages)) {
					return { ok: false, error: "A question is still open. Let the learner answer it before ending priming." };
				}
				if (hasPrimeDone(record.messages)) {
					return { ok: false, error: "Priming already ended; prime_done fires exactly once." };
				}
				try {
					ctx.deliver(newPrimeHandoffMessage(ctx.chatId) as SteerMessage);
				} catch (err) {
					// Recoverable: the next learner message builds the prober off the record anyway.
					console.error(`[chat ${ctx.chatId}] prime handoff queueing failed:`, err);
				}
				return { text: PRIME_DONE_ACK_TEXT, details: { ok: true } };
			}),
		},
	};
}

/**
 * Priming-phase contracts (the phase BEFORE the probe).
 *
 * When course materials are installed (the materi index), a teaching
 * session opens with the PRIMER: it finds the source pages for the
 * learner's topic, shows them (materi_page), boxes one block at a time and
 * explains it. Nothing is quizzed. The primer concludes with `prime_done`
 * once the learner says they are ready (or right away when there is
 * nothing to show, or the learner wants to skip). The first concluded
 * `prime_done` is the prime→probe seam: the prober is constructed from
 * then on, and the tool queues the handoff wake so the probe starts the
 * moment the primer's turn ends.
 */

import { Type, type Static } from "typebox";

/** One source page the primer walked the learner through. */
export interface PrimedPage {
	doc: string;
	page: number;
}

/** prime_done tool input. */
export interface PrimeDoneInput {
	/** The pages shown, in order. Empty when priming was skipped. */
	pages: PrimedPage[];
	/** What was covered, and where the learner seemed unsure — read by the prober. */
	summary: string;
	/** True when nothing was primed (no material found, or the learner skipped). */
	skipped?: boolean;
}

export const primeDoneInputSchema = Type.Object({
	pages: Type.Array(
		Type.Object({
			doc: Type.String({ description: "Document path exactly as materi_search printed it." }),
			page: Type.Integer({ minimum: 1 }),
		}),
		{ maxItems: 40, description: "The pages you showed, in order. Empty when you primed nothing." },
	),
	summary: Type.String({
		minLength: 1,
		description:
			"Two to five sentences for the prober: what the pages covered, which blocks you explained, " +
			"and anything the learner asked about or seemed unsure of. Write it from what happened, not from the plan.",
	}),
	skipped: Type.Optional(
		Type.Boolean({ description: "true when nothing was primed: no matching material, or the learner chose to skip." }),
	),
});

/** Schema ↔ interface lock. */
export const primeDoneSchemaLock = (v: Static<typeof primeDoneInputSchema>): PrimeDoneInput => v;

/** The prime_done ack the primer sees (the summary is the call's own input). */
export const PRIME_DONE_ACK_TEXT =
	"Priming recorded. Say one short closing sentence and end your turn; the probe takes over from here.";

/** The model-facing text of the prime→probe handoff wake. */
export const PRIME_HANDOFF_TEXT =
	"Next: probe what I now hold. I have just read the source pages above with the primer; its prime_done summary says what was covered. " +
	"Measure my understanding from there, as your instructions describe. Do not re-teach the pages.";

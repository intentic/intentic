import { z } from "zod";
import { type TurnEnding, TurnEndingSchema } from "../events/transcript.js";

// WHAT A PERSON'S CONTINUE DOES NOW: the daemon's one reading of it (AgentSummary.press), derived every time the card is
// read from what the conversation holds (turn-ending.ts turnEndingOf), the very value its record states as the transcript's
// `ending`. Every chat window used to build its own from the live error frame it happened to watch, patched from the
// record and the card, and they disagreed: a card in Finished beside a composer still saying "Limit reached, work kept"
// (2026-11-01), a composer counting down to a reopen while the daemon re-ran the turn at once (2026-10-19), a reloaded
// window with no strip at all, or one that never went away.
const AgentPressMembers = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }).describe("Nothing to continue: the last turn finished, runs now, or ended on something to repair first."),
        z.object({
            kind: z.literal("continue"),
            ending: TurnEndingSchema.describe(
                "How the last turn ended, which says what the press does: re-run the turn the daemon holds, or carry the session on.",
            ),
        }),
    ])
    .describe("What a person's Continue does for this conversation now, as the daemon reads it.");
// Named, never inferred: the card's schema then names this type instead of spelling the whole ending out inside every route
// that carries a card, which took the aggregated contract's type past what the declaration emitter will write (TS7056).
export interface NoPress {
    readonly kind: "none";
}
export interface ContinuePress {
    readonly kind: "continue";
    readonly ending: TurnEnding;
}
export type AgentPress = NoPress | ContinuePress;
export const AgentPressSchema: z.ZodType<AgentPress> = AgentPressMembers;

/** The one `none`, shared by every writer that has nothing to offer. */
export const NO_PRESS: AgentPress = { kind: "none" };

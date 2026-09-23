// turn-break: what happens next when a turn stops before it finished
//
// One ending, one question, one answer. A turn stops for exactly one reason, and that reason gets a single
// mutually-exclusive answer — never a set of switches that can all be armed at once over the same event. The chat
// asks it about the ending in front of the reader; Settings holds the standing answer per ending; a conversation may
// override either.

import { z } from "zod";

// The three endings that leave finished work behind a live session and can be picked back up. Spelled exactly as
// `TurnEndingSchema.reason` spells them, so the ending a surface reads and the question it asks are one word. A restart
// is handled apart (SandboxSettings.autoResumeOnRestart): nobody is watching a restart, so it has no in-chat question.
export const TurnBreakSchema = z.enum(["limit", "outage", "stopped"]);
export type TurnBreak = z.infer<typeof TurnBreakSchema>;

// `move` implies `resend`: an account with room is tried at once, and the reset appointment stands as its fallback.
// There is deliberately no "move, else hold" — a reader willing to spend a second account is willing to wait.
export const LimitPolicySchema = z.enum(["wait", "resend", "move"]);
export type LimitPolicy = z.infer<typeof LimitPolicySchema>;

// Both ladders answer the same way, so they share a vocabulary: nothing, or keep trying on a bounded ladder.
export const RetryPolicySchema = z.enum(["wait", "retry"]);
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// One answer, whichever ending asked. Read against the ending: only `limit` can be `move`.
export const TurnBreakPolicySchema = z.enum(["wait", "resend", "move", "retry"]);
export type TurnBreakPolicy = z.infer<typeof TurnBreakPolicySchema>;

// Which answers an ending may take, so a surface offers exactly these and a writer refuses anything else.
export const TURN_BREAK_POLICIES: Readonly<Record<TurnBreak, readonly TurnBreakPolicy[]>> = {
    limit: ["wait", "resend", "move"],
    outage: ["wait", "retry"],
    stopped: ["wait", "retry"],
};

/** Whether this ending may be answered this way; the one gate every writer goes through. */
export const isTurnBreakPolicy = (ending: TurnBreak, policy: string): policy is TurnBreakPolicy =>
    (TURN_BREAK_POLICIES[ending] as readonly string[]).includes(policy);

/** Whether an answer means something happens without the reader; the one read every "is it armed" question makes. */
export const breakArmed = (policy: TurnBreakPolicy): boolean => policy !== "wait";

// How many times a bounded ladder re-runs a turn that gets nowhere before standing down. Quoted in the notice it
// leaves, so the number and the sentence cannot drift.
export const RETRY_LADDER_MS = [5_000, 15_000, 45_000] as const;
export const RETRY_LADDER_TRIES = RETRY_LADDER_MS.length;

/** The wait before the next rung, or undefined once the ladder is spent. */
export const retryLadderDelay = (triesWithoutProgress: number): number | undefined => RETRY_LADDER_MS[triesWithoutProgress];

// Where an automatic re-run ladder stands, whichever wall climbs it (an outage's breaker, a stopped turn's rungs).
// `made` equal to `max` is a spent ladder: nothing more goes unasked.
export const RetryLadderSchema = z.object({
    made: z.number().int().min(0).describe("Automatic re-runs already sent for this turn."),
    max: z.number().int().min(1).describe("How many the ladder may send before it stands down."),
});
export type RetryLadder = z.infer<typeof RetryLadderSchema>;

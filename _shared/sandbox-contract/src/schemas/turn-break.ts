// turn-break: what happens next when a turn stops before it finished
//
// One ending, one question, one answer. A turn stops for exactly one reason, and that reason gets a single
// mutually-exclusive answer — never a set of switches that can all be armed at once over the same event. The chat
// asks it about the ending in front of the reader; Settings holds the standing answer per ending; a conversation may
// override either.

import { z } from "zod";

// The walls a turn can stop at that take a standing answer. The first three end a turn that leaves finished work behind
// a live session, spelled exactly as `TurnEndingSchema.reason` spells them, so the ending a surface reads and the
// question it asks are one word. `memory` is the door: the sandbox too short of memory to start the turn at all, which
// holds the message (or the turn the sandbox kept) until a press or room comes back. `memoryKill` is a turn that was
// running when the sandbox ran out of memory and was killed for it, whether its runtime alone was killed or the whole
// daemon went down with it (2026-11-05): it reads as a stopped turn, but what brings it back is room, not a clock, and it
// ran, so it is a question of its own rather than the stop ladder's or the door's. A restart is otherwise handled apart
// (SandboxSettings.autoResumeOnRestart): nobody is watching a restart, so it has no in-chat question.
export const TurnBreakSchema = z.enum(["limit", "outage", "stopped", "memory", "memoryKill"]);
export type TurnBreak = z.infer<typeof TurnBreakSchema>;

// Every ending that leaves a held turn behind: a spent allowance, an outage, a turn that stopped short, plus the
// provider's safety classifier stopping a turn partway. That one has no standing answer and never re-runs by itself: the
// person picks, each time, between the same model again and another one (2026-09-30, the owner's call over an automatic
// model switch). A low-memory hold is no ending: nothing ran, so it is never one of these.
export const HeldEndingSchema = z.enum(["limit", "outage", "stopped", "flagged"]);
export type HeldEnding = z.infer<typeof HeldEndingSchema>;

/** Whether this ending takes a standing answer (turn-break policy), which `flagged` never does. */
export const isTurnBreak = (ending: HeldEnding): ending is Exclude<HeldEnding, "flagged"> => ending !== "flagged";

// `move` implies `resend`: an account with room is tried at once, and the reset appointment stands as its fallback.
// There is deliberately no "move, else hold" — a reader willing to spend a second account is willing to wait.
export const LimitPolicySchema = z.enum(["wait", "resend", "move"]);
export type LimitPolicy = z.infer<typeof LimitPolicySchema>;

// Both ladders answer the same way, so they share a vocabulary: nothing, or keep trying on a bounded ladder.
export const RetryPolicySchema = z.enum(["wait", "retry"]);
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// The memory wall's two answers: hold for a press, or send once the sandbox has room again. Nothing ran, so sending it
// then spends nothing twice.
export const RoomPolicySchema = z.enum(["wait", "resend"]);
export type RoomPolicy = z.infer<typeof RoomPolicySchema>;

// A memory kill's two answers: hold it for a press, or send it again by itself once memory has stayed free, one
// conversation at a time. Never the turn whose own process was the one killed, nor one killed for memory twice already
// (MEMORY_KILL_RERUNS): those wait for a press whatever the answer, since re-running them is re-running the runaway.
export const MemoryKillPolicySchema = z.enum(["wait", "resume"]);
export type MemoryKillPolicy = z.infer<typeof MemoryKillPolicySchema>;

// One answer, whichever ending asked. Read against the ending: only `limit` can be `move`, only `memoryKill` `resume`.
export const TurnBreakPolicySchema = z.enum(["wait", "resend", "move", "retry", "resume"]);
export type TurnBreakPolicy = z.infer<typeof TurnBreakPolicySchema>;

// Which answers an ending may take, so a surface offers exactly these and a writer refuses anything else.
export const TURN_BREAK_POLICIES: Readonly<Record<TurnBreak, readonly TurnBreakPolicy[]>> = {
    limit: ["wait", "resend", "move"],
    outage: ["wait", "retry"],
    stopped: ["wait", "retry"],
    memory: ["wait", "resend"],
    memoryKill: ["wait", "resume"],
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

// How many times the sandbox sends one request again by itself after memory killed it. The kill after that holds it for
// a press: a turn killed for memory every time it runs is more likely the cause than a victim, whatever its process was
// called. Quoted in the notice that holds it, so the number and the sentence cannot drift.
export const MEMORY_KILL_RERUNS = 2;

// The mark a held turn carries where memory killed it: the failure frame's `held` (agent-events.ts) and the recorded
// ending's (transcript.ts TurnEnding), which the card's press repeats. A memory kill is held as a stop, so without the
// mark a surface asked the stop's question, whose answer sets the stop ladder that a memory kill never climbs, and the
// question that does decide it was asked nowhere. One schema for both, so the frame and the record cannot word it apart.
export const MemoryKillMarkSchema = z
    .boolean()
    .optional()
    .describe(
        "Killed because the sandbox ran out of memory: the answer that decides whether it goes again by itself is the memory kill's (wait, or resume once memory has stayed free), not the stop's. Absent for every other hold.",
    );

/** The wait before the next rung, or undefined once the ladder is spent. */
export const retryLadderDelay = (triesWithoutProgress: number): number | undefined => RETRY_LADDER_MS[triesWithoutProgress];

// Where an automatic re-run ladder stands, whichever wall climbs it (an outage's breaker, a stopped turn's rungs).
// `made` equal to `max` is a spent ladder: nothing more goes unasked.
export const RetryLadderSchema = z.object({
    made: z.number().int().min(0).describe("Automatic re-runs already sent for this turn."),
    max: z.number().int().min(1).describe("How many the ladder may send before it stands down."),
});
export type RetryLadder = z.infer<typeof RetryLadderSchema>;

import type { AgentTurn } from "@intentic/sandbox-contract";

/* WHO A TURN WAS, KEPT SO A LATER TURN CAN BE THE SAME ONE.
 *
 * Two things in this daemon start a turn that CONTINUES an earlier one rather than answering a person: a watch
 * waking its conversation when the condition it was armed for fires (agent/verification/watchers.ts), and the
 * proof follow-up sent when a turn ended on unverified work (agent/verification/verify-nudge.ts). Neither is a
 * fresh piece of work. Both are the same agent picking its own thread back up, and both therefore have to
 * reproduce the turn they continue rather than open a new one beside it.
 *
 * WHY IT IS A TYPE AND A FUNCTION RATHER THAN A HABIT. Both callers spelled this out inline, and both spelled
 * out a DIFFERENT SUBSET: provider, harness, account, model and effort travelled, while `thinking`, `fast` and
 * `actsAs` did not. So a wake continuing a turn that had reasoning switched off came back with the model's own
 * default reasoning ON — a different model behaviour, at a different price, for work the agent was told to
 * continue — and a wake continuing a persona's turn came back as NOBODY, losing that card's toolbox, its
 * signed-in accounts and its own model ladder. Neither was a decision; both were a list of fields written twice
 * and completed once. Written once, the omission has nowhere to live.
 *
 * ABSENT MEANS ABSENT, every field, which is why this is conditional spreads rather than a plain copy. Under
 * `exactOptionalPropertyTypes` a present-but-undefined `account` is a REQUEST to run on an account of that name,
 * not a request to take the provider's first; the same distinction decides whether `actsAs` means "no persona"
 * or "the persona literally called undefined". `isolated` and `unattended` keep their `=== true` reading for the
 * same reason in the other direction: a seed that carried `isolated: false` onto the wake would be asserting
 * something about placement that the arming turn never said.
 *
 * WHAT IS NOT HERE IS THE SESSION. A provider session is looked up at DELIVERY time, never snapshotted: the
 * conversation goes on advancing while a watch waits, and resuming the session the arming turn happened to hold
 * would drop everything said since. */
export type TurnSeed = Pick<
    AgentTurn,
    "agent" | "harness" | "account" | "model" | "effort" | "thinking" | "fast" | "actsAs" | "isolated" | "unattended" | "runRole"
>;

/* The fields copied whenever the arming turn said them. A table rather than one conditional spread each,
 * because the list IS the point of this module — an omission here is the bug it exists to stop — and a list is
 * easier to read against `TurnSeed` than eleven near-identical lines are.
 *
 * `runRole` is in it, and carried as ABSENT when the turn had none. There used to be a `watch-wake` role and a
 * `verify-nudge` role underneath this pair, each a settings row naming what a wake or a nudge should run on.
 * Neither could ever bind: both callers already copy the continued turn's own model, and the daemon's fill step
 * consults a role only for a turn that is unattended AND names no model AND no provider (turn-resume.ts
 * withRoleModel). A row requiring all three of a turn that has just told us its model is a row describing
 * nothing — and what it advertised, that an unwatched follow-up might move to a cheaper model, is the one thing
 * a follow-up must not do: it would ask a different agent about somebody else's edits, from a cold cache. */
const CARRIED = ["agent", "harness", "account", "model", "effort", "thinking", "fast", "actsAs", "runRole"] as const;

/** The seed as turn fields, ready to spread into the turn a wake or a nudge starts. */
export const seedFields = (seed: TurnSeed): TurnSeed => ({
    ...Object.fromEntries(CARRIED.flatMap((key) => (seed[key] === undefined ? [] : [[key, seed[key]] as const]))),
    /* The two postures, read as `=== true` rather than "present", which is the one place absent and false have
     * to differ: a seed carrying `isolated: false` onto the wake would assert something about placement that the
     * arming turn never said. */
    ...(seed.isolated === true ? { isolated: true } : {}),
    ...(seed.unattended === true ? { unattended: true } : {}),
});

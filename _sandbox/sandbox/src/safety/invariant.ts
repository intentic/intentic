import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: this subsystem is one document and one append-only record, and neither has a second
 * copy to disagree with. The policy is a file read straight through to the judge's prompt — nothing caches it,
 * nothing derives from it, and its absence is a normal state (the shipped default), not a fault to reconcile.
 * The log is evidence rather than state: nothing reads it back to decide anything, so a lost or trimmed entry
 * costs a reader something to look at and costs no decision its input.
 *
 * The one thing here that COULD drift is a card the log records as `asked` and never amends, when the turn dies
 * under it. That is not a broken invariant, it is what actually happened, and the schema says so: an entry with
 * `outcome: "asked"` and no `answer` is a card nobody ever answered. Reconciling it would be inventing an
 * answer the owner never gave. */

export const owner = "safety";

export const checks = (): readonly InvariantCheck[] => [];

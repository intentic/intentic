import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: the sidecar service is a trigger over the fileq CLI, and what it converges is a cache
 * the CLI regenerates on demand. A missing shadow costs a parse mid-task, never a wrong answer, and nothing
 * else keeps a record of which shadows exist for a relationship to break. Its own state is one in-flight child
 * and the batch queued behind it, both of which die with the process. */

export const owner = "derived";

export const checks = (): readonly InvariantCheck[] => [];

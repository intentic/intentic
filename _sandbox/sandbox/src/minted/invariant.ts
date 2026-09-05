import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: this subsystem holds no state that could disagree with anything. A keyed provider's
 * credential is a file the user pasted, read on demand and never cached; its catalog is the shared discovery
 * ladder, whose whole design is that only a live answer is cached and every other rung is re-read; and there
 * is no process, socket, config file or background timer here at all — the point of these providers is that
 * they speak the harness's own wire, so nothing is started on their behalf.
 *
 * The two facts worth guarding are guarded where they are DECIDED rather than at runtime: that every keyed
 * provider has a module, a seed floor and no adapter is the provider registry's own test, and that its two
 * base URLs name one vendor and its turn base carries no version segment is the contract's spec-table test.
 * Both are compile-and-test-time answers about a table, which is where a table's invariants belong. */

export const owner = "keyed";

export const checks = (): readonly InvariantCheck[] => [];

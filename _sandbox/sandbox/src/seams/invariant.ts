import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: this subsystem is the ports and conventions others meet at (the turn port, the domain events
 * bus, the runtime-change feed, the workload stamp, the unset-role error). None keeps a record another could disagree
 * with; the bus and the feed hold only who is listening.
 */

export const owner = "seams";

export const checks = (): readonly InvariantCheck[] => [];

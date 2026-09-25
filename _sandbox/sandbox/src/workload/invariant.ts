import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: the workload class is applied to a process as it starts and kept by the kernel, not by this
 * subsystem, and the resource budget's one record, its reservation ledger, holds nothing past ninety seconds and is
 * pruned on every read. There is no second copy of either for them to disagree with.
 */

export const owner = "workload";

export const checks = (): readonly InvariantCheck[] => [];

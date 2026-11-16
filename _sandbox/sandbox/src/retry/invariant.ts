import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: failure-backoff holds only in-memory timing per key (when to try next, which reasons an outage
 * already logged), owned by each caller and gone with the process. Nothing is stored that another subsystem could find
 * out of step; its rule (log once per outage, back off, stop on a permanent refusal) is held by its tests.
 */

export const owner = "retry";

export const checks = (): readonly InvariantCheck[] => [];

import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the call channel holds only in-flight calls, which its callers own; pairing answers to calls and respawning after a crash is pinned by worker-calls.test.ts. */

export const owner = "workers";

export const checks = (): readonly InvariantCheck[] => [];

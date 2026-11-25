import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: these are manual evals that grade a real agent from outside a sandbox container, never daemon code. */

export const owner = "evals";

export const checks = (): readonly InvariantCheck[] => [];

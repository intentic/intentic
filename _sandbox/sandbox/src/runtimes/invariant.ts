import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: `runtimes/` is a shelf rather than a subsystem. */

export const owner = "runtimes";

export const checks = (): readonly InvariantCheck[] => [];

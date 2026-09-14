import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: this subsystem is two judgements and a lookup. */

export const owner = "dependencies";

export const checks = (): readonly InvariantCheck[] => [];

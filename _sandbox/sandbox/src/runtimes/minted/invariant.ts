import type { InvariantCheck } from "../../invariants/invariants.js";

/* No runtime invariant: this subsystem holds no state that could disagree with anything. */

export const owner = "keyed";

export const checks = (): readonly InvariantCheck[] => [];

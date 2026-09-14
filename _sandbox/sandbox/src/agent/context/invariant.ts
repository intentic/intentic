import type { InvariantCheck } from "../../invariants/invariants.js";

/* No runtime invariant: the context is a field on a persona card the owner writes and this subsystem only reads. */

export const owner = "context";

export const checks = (): readonly InvariantCheck[] => [];

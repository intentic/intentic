import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: this subsystem is one document and one append-only record, and neither has a second copy to disagree with. */

export const owner = "safety";

export const checks = (): readonly InvariantCheck[] => [];

import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the data protection page holds no state of its own. Its report and documents are read from the live settings, privacy policy and capability stores at the moment they are asked for, and the preset writes through those stores' own paths; what the preset proposes and never loosens is pinned by compliance.test.ts. */

export const owner = "compliance";

export const checks = (): readonly InvariantCheck[] => [];

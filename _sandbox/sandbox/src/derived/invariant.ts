import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the sidecar service is a trigger over the fileq CLI, and what it converges is a cache the CLI regenerates on demand. */

export const owner = "derived";

export const checks = (): readonly InvariantCheck[] => [];

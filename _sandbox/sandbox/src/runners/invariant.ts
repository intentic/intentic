import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: a runner is a peer door, and the one promise a door makes — every live socket belongs to an id the enrollment store still holds — is checked for all three doors by peers/invariant.ts. */

export const owner = "runners";

export const checks = (): readonly InvariantCheck[] => [];

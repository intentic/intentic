import type { InvariantCheck } from "../invariants/invariants.js";

/* Peer-door invariants are checked by the shared substrate, so this module has no local checks. */

export const owner = "runners";

export const checks = (): readonly InvariantCheck[] => [];

import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: this directory is the substrate two tunnel kinds are instances of, and it holds no state of its own to be wrong about. */

export const owner = "tunnel";

export const checks = (): readonly InvariantCheck[] => [];

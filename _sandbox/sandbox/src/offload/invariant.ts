import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: offloaded commands are ephemeral relays to runners; live runs and recent records are in-memory only and hold no persistent state. */

export const owner = "offload";

export const checks = (): readonly InvariantCheck[] => [];

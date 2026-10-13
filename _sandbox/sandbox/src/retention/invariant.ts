import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: the retention sweep keeps no record of its own. It reads settings.retention and deletes through
 * the stores that own each kind (conversations, history, the privacy vault, caches, logs), whose own invariants and
 * tests hold; what it deleted is logged and handed to `record` per run, never stored here.
 */

export const owner = "retention";

export const checks = (): readonly InvariantCheck[] => [];

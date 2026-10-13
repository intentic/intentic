import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: each half keeps its state in one file it writes in the same step as the move it records (a task's
 * state with its version on the taking side, a handed-over task's settling on the asking side), and the asking side's
 * followers are rebuilt from that file at every boot. Nothing is held in memory that the file does not also say, so
 * there is no drift between two copies to watch; the protocol between the halves is pinned by tests/link-e2e.
 */

export const owner = "links";

export const checks = (): readonly InvariantCheck[] => [];

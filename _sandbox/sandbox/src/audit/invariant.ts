import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the trail is one append-only chain with no second copy in the daemon to disagree with, and the promise it does make (every record links to the one before it) is checked on asking by /audit/verify, which reads every record kept and is too costly to run on the invariant sweep's clock. */

export const owner = "audit";

export const checks = (): readonly InvariantCheck[] => [];

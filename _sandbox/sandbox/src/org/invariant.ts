import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the one record kept here, the organisation policy this sandbox enforces (org-policy.json in the auth root), is the daemon's own file, written whole by org-policy.ts and replaced by the platform's next answer within minutes; there is no second file it has to agree with. A held file that does not read is logged where it is read, and the next fetch rewrites it. */

export const owner = "org";

export const checks = (): readonly InvariantCheck[] => [];

import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: what the hub made is reconciled against the keyring copies after every keyring read, so a drift between the two is repaired by the next pass rather than watched for. */

export const owner = "hub";

export const checks = (): readonly InvariantCheck[] => [];

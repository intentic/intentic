import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: a connected device is a peer door, and both promises a door makes — every live socket belongs to an id the enrollment store still holds, and every enrollment to a capability card that still grants it — are checked by peers/invariant.ts. */

export const owner = "hosts";

export const checks = (): readonly InvariantCheck[] => [];

import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: this subsystem holds no state of its own. Every call is one buffered question to the platform
 * or one flow on a device, and the two things that could drift — the provisioning token and the sandboxes it made —
 * are owned elsewhere: the token by the capability manifest, the sandboxes by the account. A claim it mints is spent
 * within the same call or expires on its own.
 */

export const owner = "fleet";

export const checks = (): readonly InvariantCheck[] => [];

import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: the one state this subsystem holds is .intentic/records/needs.json, each need parsed on its own
 * against NeedSchema, so a bad row costs itself and never the rest. What an open need waits on is re-asked of its kind
 * on a timer (checkOpen), so one met outside the card closes on the next poll, and the store trims closed needs itself.
 */

export const owner = "needs";

export const checks = (): readonly InvariantCheck[] => [];

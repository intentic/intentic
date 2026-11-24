import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: what this subsystem keeps reads back through its own documents' schemas on every use. A pairing
 * or a route secret that no longer parses refuses its file rather than admitting anyone (onUnreadable: "refuse"), the
 * pass cache lives in memory for minutes, and the outbox it drains is checked by the issues inbox's own reading.
 */

export const owner = "account-routing";

export const checks = (): readonly InvariantCheck[] => [];

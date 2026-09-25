import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: these are the phases of coming up, not a subsystem that holds state. Each one runs once and hands what it started to the subsystem that owns it, so there is nothing here for a later sweep to find disagreeing with itself; what boot itself must hold — the declared order, the gate, and every timer going through the shutdown store — is shape, pinned by boot-order.test.ts and boot-shutdown.test.ts, and the ownership claim this process rests on is checked by system/invariant.ts. */

export const owner = "bootstrap";

export const checks = (): readonly InvariantCheck[] => [];

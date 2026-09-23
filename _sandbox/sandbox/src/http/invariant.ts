import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: raw-route registration and response compression hold no state; every route carrying a declared policy is shape, pinned by raw-route-server.test.ts. */

export const owner = "http";

export const checks = (): readonly InvariantCheck[] => [];

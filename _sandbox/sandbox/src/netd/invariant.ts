import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the control socket to netd holds no state beyond its socket, and that socket closing stops this daemon; the framing is pinned by netd-link.test.ts and netd's own tests. */

export const owner = "netd";

export const checks = (): readonly InvariantCheck[] => [];

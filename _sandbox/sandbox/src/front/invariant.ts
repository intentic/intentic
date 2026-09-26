import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the control socket to the front holds no state beyond its socket, and that socket closing stops this daemon; the framing is pinned by front-link.test.ts and the front's own tests. */

export const owner = "front";

export const checks = (): readonly InvariantCheck[] => [];

import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the forge module holds no state of its own beyond short-lived caches (a run's job list, the
   workflow files a run ran, an account's rate-limit cooldown), each rebuilt from the forge on the next call. What CI keeps
   about a repository lives in the CI store, which ci/ checks. */

export const owner = "forge";

export const checks = (): readonly InvariantCheck[] => [];

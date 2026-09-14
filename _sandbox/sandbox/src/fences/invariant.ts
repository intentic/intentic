import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: these are vitest setup files, the fences that keep a suite off this machine's tmux server and engine store. */

export const owner = "fences";

export const checks = (): readonly InvariantCheck[] => [];

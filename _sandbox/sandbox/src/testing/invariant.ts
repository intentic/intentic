import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: these are vitest setup files, the fences that keep a suite off this machine's tmux
 * server and engine store. Nothing here runs in the daemon; the companion exists so the registry's one list
 * (invariants/register.ts) can say so rather than the gate having to carry an exception for the directory. */

export const owner = "testing";

export const checks = (): readonly InvariantCheck[] => [];

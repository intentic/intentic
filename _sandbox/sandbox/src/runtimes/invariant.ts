import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: `runtimes/` is a shelf rather than a subsystem. The nine agent runtimes on it (claude,
 * codex, cursor, gemini, grok, kimi, minted, pi, acp) are independent adapters behind one seam (agent/adapter.ts),
 * and each one that has something to claim carries its own companion beside its code — cursor/invariant.ts holds
 * the command gate, minted/invariant.ts the minted-credential claim. A check ABOUT the shelf would have no
 * subject: the directory holds no state and no code of its own. The companion exists so the registry's one list
 * (invariants/register.ts) can say so, rather than the gate carrying an exception for the directory. */

export const owner = "runtimes";

export const checks = (): readonly InvariantCheck[] => [];

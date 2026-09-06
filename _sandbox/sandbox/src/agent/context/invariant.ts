import type { InvariantCheck } from "../../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: the context is a field on a persona card the owner writes and this subsystem only reads,
 * and a composition is one field on the registry entry, written once beside the worktrees it shaped. The relationship
 * that could break, "the checkout holds what the composition says", is converged rather than recorded: every
 * turn hands the composition back to worktrees.ts `ensure`, which brings the checkout to it, so a drift between
 * the two lasts until the next turn and never survives one. The registry's own invariants cover the entry. */

export const owner = "context";

export const checks = (): readonly InvariantCheck[] => [];

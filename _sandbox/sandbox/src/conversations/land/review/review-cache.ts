import type { AgentChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { generationMemo } from "../../../git/feed/generation-memo.js";
import type { IsolatedAgent } from "../../registry/agents-store.js";
import { intoOf, landTargetOf } from "../land-target.js";
import { reviewOf, type ReviewDeps } from "./review.js";

// The checkout feed excludes ignored directories and holes in the composition. Always refresh those peripherals;
// cache only the expensive Git review. Authorization stays in the route, before this reader is reached.
export const createReviewReader = (deps: ReviewDeps): ((entry: IsolatedAgent) => Promise<AgentChanges>) => {
    const memo = generationMemo<AgentChanges>({ maxAgeMs: 10_000, maxEntries: 32 });
    return async (entry) => {
        const into = intoOf(await landTargetOf(deps, entry));
        const dirs = entry.placement.repos.flatMap(({ repo }) => [
            deps.agentWorktrees.worktreeDir(entry.id, repo),
            deps.agentWorktrees.mainDir(repo),
            ...(into === undefined ? [] : [deps.agentWorktrees.worktreeDir(into, repo)]),
        ]);
        const metadata = JSON.stringify([entry.placement, entry.landing, into, entry.placement.repos.map(({ repo }) => deps.agentWorktrees.repoBusy(repo))]);
        return reviewOf(deps, entry, (read) => memo(entry.id, dirs, metadata, read));
    };
};

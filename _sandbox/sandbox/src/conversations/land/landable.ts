import { join } from "node:path";
import { pathExists } from "@intentic/base/fs";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { mainLineStanding, OffMainLineError } from "../../git/main-line-lock.js";
import { standsOnMainLine } from "../../git/main-line-tip.js";
import type { IsolatedAgent } from "../registry/agents-store.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import { assertLinked } from "../worktrees/checkout-link.js";
import { branchOf } from "./branch/branch-repos.js";

// The stops a land makes before it reads anything, each with a plain reason the card keeps (land-failure.ts): a
// conversation's checkout that no longer shares its repository's objects (checkout-link.ts), and a shared checkout
// someone moved off its main line anyway (git/main-line-lock.ts). Written into as it stands, the second would put the
// work on whatever branch it was moved to, uncommitted, and measured against the wrong line; it waits instead until the
// checkout is back, which the Changes view offers. Asked only of the trees the land writes into: a parent's checkout is
// the parent's own business, and a repo started from a branch lands onto that branch's checkout (branch-land.ts).
export const assertLandable = async (
    worktrees: Pick<AgentWorktrees, "relink" | "mainDir">,
    entry: IsolatedAgent,
    into: string | undefined,
    git: GitRunner = defaultGit,
): Promise<void> => {
    await assertLinked(worktrees, entry.id, entry.placement.repos);
    if (into !== undefined) {
        return;
    }
    for (const { repo } of entry.placement.repos) {
        const main = worktrees.mainDir(repo);
        // A vanished main checkout is the land's own conflict to report (land.ts planRepo).
        if (branchOf(entry.placement, repo) !== undefined || !(await pathExists(join(main, ".git")))) {
            continue;
        }
        // The cheap read first, asked of every repo at every land; git's own answer only where it says no.
        if (await standsOnMainLine(main, git)) {
            continue;
        }
        const standing = await mainLineStanding(main, git);
        if (!standing.on && standing.locked !== undefined) {
            throw new OffMainLineError(repo, standing.locked, standing.current);
        }
    }
};

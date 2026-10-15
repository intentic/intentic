import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { OutsideCheckout } from "@intentic/sandbox-contract";
import { headSha } from "../../git/changes/changes.js";
import { currentRepos } from "../../workspace/watch/repo-watch.js";
import { isMirrorResidue } from "./checkout-aside.js";
import type { AgentWorktrees } from "./worktrees.js";

// WORK WRITTEN WHERE NO CHECKOUT OF THIS CONVERSATION STANDS. Every workspace repo the conversation does not carry is a
// hole in its root checkout: the root excludes the path as it excludes every repo, so what a turn writes there reaches
// no branch, no review and no land, and the review used to read as an agent that wrote nothing. Listed here, per repo,
// only where the hole actually holds files: a repo merely not carried is the composition's business (persona and area
// notes say that), and naming it would put every repo outside a fence on a fenced conversation's review.

// Files counted per hole before the count stops; the review reads this on every refresh.
const COUNT_MAX = 1_000;

// Files under `dir`, a checkout of its own and the root checkout's mirrors left out, up to `room`.
const filesUnder = async (dir: string, room: number): Promise<number> => {
    let found = 0;
    const pending = [dir];
    while (pending.length > 0 && found < room) {
        const current = pending.pop() ?? dir;
        // oxlint-disable-next-line eslint/no-await-in-loop -- one directory at a time keeps the walk inside its ceiling
        const entries = (await readdir(current, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
        if (current !== dir && entries.some((entry) => entry.name === ".git")) {
            continue;
        }
        for (const entry of entries) {
            const path = join(current, entry.name);
            // oxlint-disable-next-line eslint/no-await-in-loop -- see above
            if (entry.name === ".git" || (await isMirrorResidue(path))) {
                continue;
            }
            if (entry.isDirectory()) {
                pending.push(path);
            } else {
                found += 1;
            }
        }
    }
    return Math.min(found, room);
};

// Why a repo is not in the checkout: it has no commit to branch from, git cannot read it, or the composition leaves it
// out (a persona's chosen repos, or one the conversation has not met a turn since).
const reasonOf = async (main: string, git: GitRunner): Promise<OutsideCheckout["reason"]> => {
    try {
        return (await headSha(main, git)) === undefined ? "unborn" : "not-carried";
    } catch {
        // allow(silent-catch): a repo git cannot read is exactly what this reason reports.
        return "unreadable";
    }
};

export const outsideCheckout = async (
    worktrees: Pick<AgentWorktrees, "worktreeDir" | "mainDir">,
    workspaceRoot: string,
    id: string,
    composed: readonly { readonly repo: string }[],
    git: GitRunner = defaultGit,
): Promise<OutsideCheckout[]> => {
    // No root checkout on disk (retired, or never cut): no holes to read, and its branch holds nothing of them.
    if (!composed.some(({ repo }) => repo === "root") || (await lstat(worktrees.worktreeDir(id, "root")).catch(undefinedIfMissing)) === undefined) {
        return [];
    }
    const carried = new Set(composed.map(({ repo }) => repo));
    const outside: OutsideCheckout[] = [];
    for (const repo of (await currentRepos(workspaceRoot)).filter((live) => !carried.has(live))) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- nearly always zero repos; one walk at a time when not
        const files = await filesUnder(worktrees.worktreeDir(id, repo), COUNT_MAX);
        if (files > 0) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- see above
            outside.push({ repo, reason: await reasonOf(worktrees.mainDir(repo), git), files });
        }
    }
    return outside;
};

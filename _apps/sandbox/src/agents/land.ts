import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandResult } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { changedFiles } from "../git/changes.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import type { PersistedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "./worktrees.js";

// Land a conversation's work into the main tree as UNCOMMITTED changes — the Claude Code review model: the
// agent's finished delta appears in the user's normal Changes panel and their own commit is the review
// boundary. Per repo of the composition: preserve the worktree's dirty state as an agent-authored commit on
// agent/<id> (provenance — nothing is ever lost), take the delta `landedTip ?? base → tip` as a binary
// rename-aware patch, `git apply --check` it against the main tree, and apply working-tree-only. Main's HEAD
// never moves; landedTip advances so the next land applies only the new delta. A patch that can't apply
// (the user edited the same lines, or an overlapping dirty/untracked path) lands NOTHING for that repo and
// reports it — the worktree keeps everything and "Land now" recovers once the user resolves. Called
// automatically at clean turn completion (streamAgent) and manually from the /agents land route.

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

const withAgentAuthor = ["-c", `user.name=${AGENT_GIT_AUTHOR.name}`, "-c", `user.email=${AGENT_GIT_AUTHOR.email}`];

// The wire LandResult plus what the registry persists: `changed` distinguishes "nothing to land" (no frame,
// no status change) from a real outcome, `repos` carries the advanced landedTips, and `diff` is the agent's
// CUMULATIVE base→tip output across the composition (refreshed here because land already holds the shas) —
// independent of how much of it has landed.
export interface LandOutcome extends LandResult {
    readonly changed: boolean;
    readonly repos: PersistedAgent["repos"];
    readonly diff: { files: number; insertions: number; deletions: number };
}

// `git diff --shortstat` line: " 3 files changed, 10 insertions(+), 2 deletions(-)" — every term optional.
const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

export const landAgent = async (worktrees: AgentWorktrees, entry: PersistedAgent, git: GitRunner = defaultGit): Promise<LandOutcome> => {
    const conflicts: { repo: string; paths: string[] }[] = [];
    const repos: PersistedAgent["repos"] = [];
    const diff = { files: 0, insertions: 0, deletions: 0 };
    let changed = false;
    // One temp dir for the run's patch files, removed whole in the finally.
    const patchDir = await mkdtemp(join(tmpdir(), "intentic-land-"));
    try {
        for (const composed of entry.repos) {
            const { repo, base } = composed;
            let next: PersistedAgent["repos"][number] = composed;
            await worktrees.withRepoLock(repo, async () => {
                const worktree = worktrees.worktreeDir(entry.id, repo);
                if (!(await exists(worktree))) {
                    return;
                }
                const main = worktrees.mainDir(repo);
                if (!(await exists(join(main, ".git")))) {
                    // The main checkout vanished — nothing to apply into; surfaced, not silently skipped.
                    conflicts.push({ repo, paths: [] });
                    changed = true;
                    return;
                }
                // 1. Preserve the worktree's uncommitted state as an agent-authored commit on its branch.
                // Dirty on EITHER side — the agent may have staged some of its work and left the rest loose;
                // the commit below (`add -A`) sweeps up both, so the guard has to look at both.
                const worktreeState = await changedFiles(worktree, git);
                if (worktreeState.staged.length + worktreeState.unstaged.length > 0) {
                    await git(worktree, ["add", "-A"]);
                    await git(worktree, [...withAgentAuthor, "commit", "-q", "-m", `Agent: ${entry.title ?? entry.id}`]);
                }
                const tip = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
                // Cumulative diffstat vs the BASE (not landedTip) — the agent's total output for the card.
                if (tip !== base) {
                    const stat = SHORTSTAT.exec((await git(worktree, ["diff", "--shortstat", base, tip])).stdout);
                    if (stat !== null) {
                        diff.files += Number(stat[1]);
                        diff.insertions += Number(stat[2] ?? 0);
                        diff.deletions += Number(stat[3] ?? 0);
                    }
                }
                const from = composed.landedTip ?? base;
                if (tip === from) {
                    return; // Everything already landed for this repo.
                }
                changed = true;
                // 2. Patch-apply the delta onto the main WORKING TREE only — no index, no commit: the result
                // is plain unstaged changes, exactly what the Changes panel reviews. `apply --check` is the
                // conflict gate, and it is CONTEXT-based, which is what makes incremental landing work: a
                // main file still holding the previously-landed (`from`) content matches the patch context and
                // applies cleanly, while a user edit on the same lines mismatches and applies NOTHING. A
                // path-set overlap test can't make that distinction (it would flag every re-touched file).
                const patch = (await git(main, ["diff", "--binary", "-M", from, tip])).stdout;
                if (patch === "") {
                    // A net-zero delta — the agent reverted everything it did since the last land. There is
                    // nothing to apply (`git apply` rejects an empty patch), but the tip must still advance,
                    // or every future land re-reports this range as a phantom conflict nothing can resolve.
                    next = { repo, base, landedTip: tip };
                    return;
                }
                const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.patch`);
                await writeFile(patchPath, patch);
                try {
                    await git(main, ["apply", "--check", patchPath]);
                } catch {
                    // Best-effort conflict hint: the delta paths the user's uncommitted work also touches
                    // (rename `from` legs included); when that intersection is empty, name the whole delta.
                    const deltaPaths = (await git(main, ["diff", "--name-only", "-z", from, tip])).stdout.split("\0").filter((path) => path !== "");
                    // Both sides: a path the user staged conflicts with the incoming patch exactly as much as
                    // one they left unstaged, so the overlap test must consider the union.
                    const mainState = await changedFiles(main, git);
                    const mainDirty = new Set<string>();
                    for (const change of [...mainState.staged, ...mainState.unstaged]) {
                        mainDirty.add(change.path);
                        if (change.from !== undefined) {
                            mainDirty.add(change.from);
                        }
                    }
                    const overlap = deltaPaths.filter((path) => mainDirty.has(path));
                    conflicts.push({ repo, paths: overlap.length > 0 ? overlap : deltaPaths });
                    return;
                }
                await git(main, ["apply", patchPath]);
                next = { repo, base, landedTip: tip };
            });
            repos.push(next);
        }
    } finally {
        await rm(patchDir, { recursive: true, force: true });
    }
    return { landed: conflicts.length === 0, changed, repos, diff, ...(conflicts.length > 0 ? { conflicts } : {}) };
};

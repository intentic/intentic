import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandConflict, LandConflictReason, LandMode, LandResult } from "@intentic/sandbox-contract";
import { defaultGit, gitCommitAll, type GitRunner } from "@intentic/scaffold";
import { changedFiles, headSha } from "../git/changes.js";
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

// `git merge-base --is-ancestor` answers by exit code, which the runner surfaces as a throw.
const isAncestor = async (dir: string, ancestor: string, descendant: string, git: GitRunner): Promise<boolean> => {
    try {
        await git(dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
        return true;
    } catch {
        return false;
    }
};

/* WHERE this land's delta is measured from — which decides what "this agent's work" even means.
 *
 * An incremental land continues from `landedTip`, so a second land carries only what the agent has done
 * since the first. Everything else asks git: the agent's own work is what its tip has that the main line does
 * not, i.e. the delta from their MERGE-BASE.
 *
 * The base recorded at worktree creation is only the last resort, because it is a sha frozen in time and the
 * branch does not have to keep agreeing with it. Rebase an agent onto the current main line — the natural
 * response to being told the main tree moved on — and the branch now CONTAINS main's commits. Diffing from
 * the frozen base then yields "what this agent did PLUS everything main did since": a patch of dozens of
 * files that can never apply, because the main tree already has its own half of it. What the user sees for
 * that is a conflict report naming files the agent never touched, and no way forward. The merge-base is
 * immune — it moves with the rebase, and the delta stays exactly the agent's own work. */
const anchorOf = async (
    worktree: string,
    main: string,
    tip: string,
    landedTip: string | undefined,
    base: string,
    git: GitRunner,
): Promise<string> => {
    // Only while the branch still descends from it: a rewrite that dropped the landed work has to re-land it.
    if (landedTip !== undefined && (await isAncestor(worktree, landedTip, tip, git))) {
        return landedTip;
    }
    const head = await headSha(main, git);
    if (head !== undefined) {
        try {
            const merged = (await git(worktree, ["merge-base", head, tip])).stdout.trim();
            if (merged !== "") {
                return merged;
            }
        } catch {
            // Unrelated histories — fall through to the recorded base.
        }
    }
    return base;
};

/* WHICH paths of a delta actually refuse to apply, and why.
 *
 * `git apply` is ATOMIC: one unapplicable file rejects the entire patch. So a failed bulk check says only
 * "something in here does not fit" — it says nothing about WHAT, and the first version of this code guessed,
 * intersecting the delta with the main tree's dirty paths and falling back to naming the whole delta when
 * that intersection came up empty. That fallback fires exactly when the cause is a moved main line, which is
 * the common case, so the common case reported every file as a conflict.
 *
 * Re-checking each path on its own is the only way to tell four real conflicts from the fourteen an atomic
 * failure implicates. Rename detection stays on so each probe sees the same patch shape the real apply will;
 * a rename probed one leg at a time degrades to a delete plus an add, which is accurate enough for a report. */
const classifyConflicts = async (
    main: string,
    from: string,
    tip: string,
    patchDir: string,
    repo: string,
    git: GitRunner,
): Promise<{ paths: { path: string; reason: LandConflictReason }[]; clean: number }> => {
    const deltaPaths = (await git(main, ["diff", "--name-only", "-z", from, tip])).stdout.split("\0").filter((path) => path !== "");
    // A path the user STAGED conflicts with the incoming patch exactly as much as one they left unstaged, so
    // "yours is the copy at risk" has to consider the union — rename `from` legs included.
    const mainState = await changedFiles(main, git);
    const mainDirty = new Set<string>();
    for (const change of [...mainState.staged, ...mainState.unstaged]) {
        mainDirty.add(change.path);
        if (change.from !== undefined) {
            mainDirty.add(change.from);
        }
    }
    const paths: { path: string; reason: LandConflictReason }[] = [];
    let clean = 0;
    for (const [index, path] of deltaPaths.entries()) {
        const single = (await git(main, ["diff", "--binary", "-M", from, tip, "--", path])).stdout;
        if (single === "") {
            clean += 1;
            continue;
        }
        const probePath = join(patchDir, `${repo.replaceAll("/", "_")}.probe.${index}.patch`);
        await writeFile(probePath, single);
        try {
            await git(main, ["apply", "--check", probePath]);
            clean += 1;
        } catch {
            // Binary first: it outranks the other two, because no three-way merge of it exists to offer.
            const reason: LandConflictReason = single.includes("GIT binary patch") ? "binary" : mainDirty.has(path) ? "workspace" : "diverged";
            paths.push({ path, reason });
        }
    }
    return { paths, clean };
};

export const landAgent = async (
    worktrees: AgentWorktrees,
    entry: PersistedAgent,
    mode: LandMode = "check",
    git: GitRunner = defaultGit,
): Promise<LandOutcome> => {
    const conflicts: LandConflict[] = [];
    // Only a `merge` land fills this: the paths now sitting in the workspace with conflict markers on them.
    const resolving: { repo: string; paths: string[] }[] = [];
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
                    // The main checkout vanished — nothing to apply into; surfaced, not silently skipped. No
                    // path-level account exists for it, which is what an empty `paths` with nothing clean says.
                    conflicts.push({ repo, paths: [], clean: 0 });
                    changed = true;
                    return;
                }
                // 1. Preserve the worktree's uncommitted state as an agent-authored commit on its branch —
                // staged, unstaged and untracked alike (`add -A` sweeps all three), and a no-op when staging
                // leaves the index empty. That last case is the ROOT repo of a workspace whose only change
                // lives inside a NESTED repo of the composition: root sees "modified: <repo> (modified
                // content)" but can stage nothing, because a gitlink moves only when that repo's own HEAD
                // does. The nested repo lands its own work below; root's gitlink follows whenever someone
                // commits there.
                await gitCommitAll(worktree, `Agent: ${entry.title ?? entry.id}`, AGENT_GIT_AUTHOR, git);
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
                const from = await anchorOf(worktree, main, tip, composed.landedTip, base, git);
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
                    // No provenance: nothing of this agent's is in the main tree to attribute.
                    next = { repo, base, landedTip: tip };
                    return;
                }
                const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.patch`);
                await writeFile(patchPath, patch);
                try {
                    await git(main, ["apply", "--check", patchPath]);
                } catch {
                    const report = await classifyConflicts(main, from, tip, patchDir, repo, git);
                    /* A three-way apply merges THROUGH THE INDEX, so git refuses it outright — applying not
                     * one file, not even the clean ones — as soon as any path it must fall back on differs
                     * between the working tree and the index ("does not match index"). That is precisely the
                     * `workspace` cause. So merge mode is offered only where git can actually merge: the
                     * user's own uncommitted copy has to be committed or stashed first, and saying so beats
                     * attempting it and reporting a failure they cannot read. */
                    const mergeable = report.paths.every((conflict) => conflict.reason !== "workspace");
                    if (mode === "check" || !mergeable) {
                        // What `check` promises is that a refusal leaves the workspace byte-identical. Report
                        // and stop: the worktree keeps everything, and "Land now" recovers once the user acts.
                        conflicts.push({ repo, ...report });
                        return;
                    }
                    /* `merge`: the user has read the report and asked for the three-way anyway. Every clean
                     * path lands, and each conflicted one arrives carrying the standard markers to be finished
                     * in place — the shape any merge leaves behind, in the editor they already use.
                     *
                     * `--3way` exits non-zero precisely BECAUSE it left conflicts, so a throw here is the
                     * intended outcome rather than a failure; the delta is in the tree either way. It needs
                     * both blobs to merge against, which the object store shared with the worktree has. */
                    try {
                        await git(main, ["apply", "--3way", patchPath]);
                    } catch {
                        // Nothing to add: `report` already names what was left open, and it is reported below.
                    }
                    if (report.paths.length > 0) {
                        resolving.push({ repo, paths: report.paths.map((conflict) => conflict.path) });
                    }
                    // The tip advances even with paths still open, because the delta IS in the main tree now.
                    // Holding it back would re-apply the whole thing over the user's half-finished resolution
                    // the next time anything lands.
                    const merged = await headSha(main, git);
                    next = { repo, base, landedTip: tip, ...(merged !== undefined ? { landedHead: merged } : {}), landedAt: Date.now() };
                    return;
                }
                await git(main, ["apply", patchPath]);
                // 3. Record where the main tree stood when this delta went in. It is what dates the per-file
                // attribution the Changes panel draws: while HEAD still stands here, this agent's delta IS part
                // of the repo's uncommitted content, so those paths can be credited to it. Once the user
                // commits, HEAD moves and the claim expires rather than following a path they may since have
                // re-edited themselves (agents/origins.ts). An unborn HEAD records none, and claims nothing.
                const landedHead = await headSha(main, git);
                next = { repo, base, landedTip: tip, ...(landedHead !== undefined ? { landedHead } : {}), landedAt: Date.now() };
            });
            repos.push(next);
        }
    } finally {
        await rm(patchDir, { recursive: true, force: true });
    }
    return {
        landed: conflicts.length === 0,
        changed,
        repos,
        diff,
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(resolving.length > 0 ? { resolving } : {}),
    };
};

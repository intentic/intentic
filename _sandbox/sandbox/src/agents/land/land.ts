import { mkdtemp, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathExists } from "../../path-exists.js";
import type { AgentSpan, GitChange, LandConflict, LandConflictReason, LandMode, LandResult } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { changedFiles, headSha } from "../../git/changes/changes.js";
import { parseNameStatusZ, parseNumstatZ } from "../../git/changes/changes-porcelain.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import { agentRepoChanges, anchorOf } from "./agent-changes.js";
import { branchSha, mainBranchOf } from "./agent-refs.js";
import { reconcileLockfile } from "./lockfile-reconcile.js";
import type { IsolatedAgent, PersistedAgent } from "../registry/agents-store.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// Lands a conversation's work into the main tree as uncommitted changes: preserves worktree state as a commit on
// agent/<id>, then applies each repo's anchor..tip patch working-tree-only once every repo in the composition
// preflights clean. Content that already reached main another way is never a conflict.

// Wire LandResult plus registry state: `changed` distinguishes no-op from a real outcome, `repos` carries advanced
// landedTips, `diff` is the cumulative anchor->tip stat the review itself reads.
export interface LandOutcome extends LandResult {
    readonly changed: boolean;
    readonly repos: PersistedAgent["repos"];
    readonly diff: { files: number; insertions: number; deletions: number };
    // False unless a `measure` re-judged a stored refusal; true lets a fresh verdict replace a stale one.
    readonly adjudicated: boolean;
}

// `git apply --check` (exit code as a throw); `reverse` tells a clash from content main already has, since a patch
// un-applies cleanly exactly when its post-image is already there.
const applies = async (main: string, patch: string, direction: "forward" | "reverse", git: GitRunner): Promise<boolean> => {
    try {
        await git(main, ["apply", "--check", ...(direction === "reverse" ? ["--reverse"] : []), patch]);
        return true;
    } catch {
        return false;
    }
};

// Diff written straight to a file, never held as a string, since a giant patch would blow the git runner's output
// ceiling. Returns the file's size, since that's all callers ever wanted.
const writePatch = async (main: string, patchPath: string, range: readonly string[], git: GitRunner): Promise<number> => {
    await git(main, ["diff", `--output=${patchPath}`, "--binary", "-M", ...range]);
    return (await stat(patchPath).catch(() => undefined))?.size ?? 0;
};

// One change of a delta with the complete path set its diff spans: a rename is one change across two paths, so naming
// only the destination breaks `-M` pairing and creates instead of renaming.
interface DeltaChange {
    // Destination path: what a conflict report names, since it's the path the user goes looking for.
    readonly path: string;
    // Every path this change's own diff spans: the destination, plus a rename's source.
    readonly paths: readonly string[];
    // What must not exist once this change has applied: a deletion's own path, a rename's source.
    readonly removes: readonly string[];
}

// A delta's changes split by what main makes of each: `clean` is what a land would carry, `blocked` is a genuine
// conflict. Already-in-main changes are in neither.
interface DeltaReport {
    readonly blocked: { path: string; reason: LandConflictReason }[];
    readonly clean: DeltaChange[];
}

// A `--name-status` row's path set; `from` is git's rename source. A copy carries none (parseNameStatusZ reports it as
// a plain add).
const deltaChangeOf = (change: GitChange): DeltaChange => ({
    path: change.path,
    paths: change.from === undefined ? [change.path] : [change.from, change.path],
    removes: change.status === "deleted" ? [change.path] : change.from === undefined ? [] : [change.from],
});

// Git tracks no directories, so a removal's emptied parents are debris `git apply` doesn't already prune (it prunes
// when the patch itself expresses the removal). Scoped to this delta's own removals only.
export const pruneEmptiedDirs = async (main: string, removed: readonly string[]): Promise<void> => {
    const root = resolve(main);
    for (const path of removed) {
        for (let dir = dirname(resolve(root, path)); dir !== root && dir.startsWith(root); dir = dirname(dir)) {
            try {
                await rmdir(dir);
            } catch {
                break;
            }
        }
    }
};

// `git apply` is atomic, so a failed bulk check names nothing; each change is re-probed alone, over its whole path set,
// so rename pairing stays correct. The reverse probe drops content that reached main by another road.
const classifyDelta = async (main: string, from: string, tip: string, patchDir: string, repo: string, git: GitRunner): Promise<DeltaReport> => {
    const rows = parseNameStatusZ((await git(main, ["diff", "--name-status", "-z", "-M", from, tip])).stdout);
    const changes = rows.map(deltaChangeOf);
    // Numstat, not a patch string search: a binary file has both counts omitted, keyed on the destination path.
    const stats = parseNumstatZ((await git(main, ["diff", "--numstat", "-z", "-M", from, tip])).stdout);
    const isBinary = (path: string): boolean => {
        const counts = stats.get(path);
        return counts !== undefined && counts.additions === undefined && counts.deletions === undefined;
    };
    // Staged and unstaged both count: a staged copy is as much at risk as an unstaged one, rename `from` legs included.
    const mainState = await changedFiles(main, git);
    const mainDirty = new Set<string>();
    for (const change of [...mainState.staged, ...mainState.unstaged]) {
        mainDirty.add(change.path);
        if (change.from !== undefined) {
            mainDirty.add(change.from);
        }
    }
    const blocked: { path: string; reason: LandConflictReason }[] = [];
    const clean: DeltaChange[] = [];
    for (const [index, change] of changes.entries()) {
        const probePath = join(patchDir, `${repo.replaceAll("/", "_")}.probe.${index}.patch`);
        if ((await writePatch(main, probePath, [from, tip, "--", ...change.paths], git)) === 0) {
            clean.push(change);
            continue;
        }
        if (await applies(main, probePath, "forward", git)) {
            clean.push(change);
            continue;
        }
        if (await applies(main, probePath, "reverse", git)) {
            // Already in the main tree: not clean, not a conflict, simply drops out with nothing to report.
            continue;
        }
        // Binary checked first: it outranks the other reasons, since no three-way merge of it exists.
        const reason: LandConflictReason = isBinary(change.path)
            ? "binary"
            : change.paths.some((path) => mainDirty.has(path))
              ? "workspace"
              : "diverged";
        blocked.push({ path: change.path, reason });
    }
    return { blocked, clean };
};

// Re-diffed over the changes' own paths so rename pairing stays coherent; an empty set must return early since a bare
// `--` means no pathspec, not an empty one. Explicit `rm`s finish removals a pathspec diff can silently under-express.
const applyChanges = async (
    main: string,
    from: string,
    tip: string,
    changes: readonly DeltaChange[],
    patchDir: string,
    repo: string,
    git: GitRunner,
): Promise<void> => {
    if (changes.length === 0) {
        return;
    }
    const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.remainder.patch`);
    if ((await writePatch(main, patchPath, [from, tip, "--", ...changes.flatMap((change) => change.paths)], git)) === 0) {
        return;
    }
    const removes = changes.flatMap((change) => change.removes);
    await git(main, ["apply", patchPath]);
    await Promise.all(
        // `force`: the path is already gone whenever the patch expressed its own removal.
        removes.map(async (path) => await rm(join(main, path), { force: true })),
    );
    await pruneEmptiedDirs(main, removes);
};

// Re-derives the stored conflict report live against today's tree, read-only: the stored report rots once the user
// commits or the main line moves past it. The stored event itself (what keeps the card on `conflict`) is untouched.
export const outstandingConflicts = async (worktrees: AgentWorktrees, entry: IsolatedAgent, git: GitRunner = defaultGit): Promise<LandConflict[]> => {
    const conflicts: LandConflict[] = [];
    const patchDir = await mkdtemp(join(tmpdir(), "intentic-classify-"));
    try {
        for (const { repo, base, landedTip } of entry.repos) {
            await worktrees.withRepoLock(repo, async () => {
                const main = worktrees.mainDir(repo);
                if (!(await pathExists(join(main, ".git")))) {
                    // Vanished main checkout: reported the same way land itself reports it.
                    conflicts.push({ repo, paths: [], clean: 0 });
                    return;
                }
                const attached = await worktrees.attached(entry.id, repo);
                const worktree = worktrees.worktreeDir(entry.id, repo);
                const tip = attached ? (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim() : await branchSha(main, entry.branch, git);
                if (tip === undefined) {
                    return;
                }
                const refDir = attached ? worktree : main;
                const from = await anchorOf(refDir, main, tip, landedTip, base, git);
                if (tip === from) {
                    return;
                }
                const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.patch`);
                if ((await writePatch(main, patchPath, [from, tip], git)) === 0) {
                    return;
                }
                // Applies whole or already whole: nothing refuses today, whatever refused before.
                if ((await applies(main, patchPath, "forward", git)) || (await applies(main, patchPath, "reverse", git))) {
                    return;
                }
                const report = await classifyDelta(main, from, tip, patchDir, repo, git);
                if (report.blocked.length > 0) {
                    const mainBranch = await mainBranchOf(main, git);
                    conflicts.push({
                        repo,
                        paths: report.blocked,
                        clean: report.clean.length,
                        ...(mainBranch !== undefined ? { mainBranch } : {}),
                    });
                }
            });
        }
    } finally {
        await rm(patchDir, { recursive: true, force: true });
    }
    return conflicts;
};

interface RepoLandTarget {
    readonly main: string;
    readonly repo: string;
    readonly base: string;
    readonly tip: string;
}

type RepoLandWrite =
    | (RepoLandTarget & { readonly kind: "whole"; readonly patchPath: string })
    | (RepoLandTarget & { readonly kind: "subset"; readonly from: string; readonly changes: readonly DeltaChange[] })
    | (RepoLandTarget & { readonly kind: "merge"; readonly patchPath: string; readonly paths: readonly string[] });

interface RepoLandPlan {
    next: PersistedAgent["repos"][number];
    readonly write?: RepoLandWrite;
}

// Locks stay held through both phases, or another request could stage/discard/land between check and write.
// Alphabetical order queues composed lands instead of deadlocking them.
const withRepoLocks = async <T>(worktrees: AgentWorktrees, repos: readonly string[], task: () => Promise<T>): Promise<T> => {
    const ordered = [...new Set(repos)].sort();
    const acquire = async (index: number): Promise<T> => {
        const repo = ordered[index];
        return repo === undefined ? task() : worktrees.withRepoLock(repo, async () => acquire(index + 1));
    };
    return acquire(0);
};

const advancedRepo = async (target: RepoLandTarget, git: GitRunner): Promise<PersistedAgent["repos"][number]> => {
    const landedHead = await headSha(target.main, git);
    return {
        repo: target.repo,
        base: target.base,
        landedTip: target.tip,
        ...(landedHead !== undefined ? { landedHead } : {}),
        landedAt: Date.now(),
    };
};

const applyRepoWrite = async (
    write: RepoLandWrite,
    patchDir: string,
    resolving: { repo: string; paths: string[] }[],
    git: GitRunner,
): Promise<void> => {
    switch (write.kind) {
        case "whole":
            await git(write.main, ["apply", write.patchPath]);
            return;
        case "subset":
            await applyChanges(write.main, write.from, write.tip, write.changes, patchDir, write.repo, git);
            return;
        case "merge":
            // `--3way` exits non-zero exactly because it left markers; that throw is the expected result here.
            try {
                await git(write.main, ["apply", "--3way", write.patchPath]);
            } catch {
                // The preflight report already names every path the three-way apply leaves open.
            }
            resolving.push({ repo: write.repo, paths: [...write.paths] });
    }
};

export const landAgent = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    mode: LandMode = "check",
    // 'outstanding' for automatic lands; 'cumulative' re-measures from base, the only rung that still sees a discard.
    span: AgentSpan = "outstanding",
    git: GitRunner = defaultGit,
): Promise<LandOutcome> => {
    const conflicts: LandConflict[] = [];
    // Even a `measure` re-judges a stored refusal, or 'resolve' loops forever; only a verdict may replace a verdict.
    const rejudging = mode === "measure" && (entry.conflicts?.length ?? 0) > 0;
    // Set only by a `measure` land that deliberately left an outstanding delta on the branch.
    let held = false;
    // Filled only by a `merge` land, only in phase two once every repo passed phase one.
    const resolving: { repo: string; paths: string[] }[] = [];
    const plans: RepoLandPlan[] = [];
    const diff = { files: 0, insertions: 0, deletions: 0 };
    let changed = false;
    // One temp dir for this run's patch files, removed whole in the finally.
    const patchDir = await mkdtemp(join(tmpdir(), "intentic-land-"));
    try {
        return await withRepoLocks(
            worktrees,
            entry.repos.map(({ repo }) => repo),
            async () => {
                // Phase one: read-only, computes every repo's plan; nothing is written if any repo conflicts.
                for (const composed of entry.repos) {
                    const { repo, base } = composed;
                    let next: PersistedAgent["repos"][number] = composed;
                    const main = worktrees.mainDir(repo);
                    if (!(await pathExists(join(main, ".git")))) {
                        // Vanished main checkout: surfaced as a conflict, not silently skipped.
                        conflicts.push({ repo, paths: [], clean: 0 });
                        changed = true;
                        plans.push({ next });
                        continue;
                    }
                    // A retired checkout still holds the branch's work via the shared store: not 'nothing to land'.
                    const attached = await worktrees.attached(entry.id, repo);
                    const worktree = worktrees.worktreeDir(entry.id, repo);
                    // Stages staged/unstaged/untracked alike; a no-op when the only change is a nested repo's gitlink.
                    if (attached) {
                        // Lockfile fixed before the commit: manifest and lockfile land as one commit, one patch.
                        await reconcileLockfile(worktree, composed.landedTip ?? base, git);
                        await commitWorktreeRemainder(repo, worktree, `Agent: ${entry.title ?? entry.id}`, git);
                    }
                    const tip = attached ? (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim() : await branchSha(main, entry.branch, git);
                    if (tip === undefined) {
                        plans.push({ next });
                        continue;
                    }
                    // Ref-only reads run where the refs live: the worktree while attached, the main repo after.
                    const refDir = attached ? worktree : main;
                    // Totalled by the review's own reader, so the card's count can't disagree with the review.
                    for (const change of await agentRepoChanges(worktrees, entry, composed, "cumulative", git)) {
                        diff.files += 1;
                        diff.insertions += change.additions ?? 0;
                        diff.deletions += change.deletions ?? 0;
                    }
                    const from = await anchorOf(refDir, main, tip, span === "cumulative" ? undefined : composed.landedTip, base, git);
                    if (tip === from) {
                        // Ancestry alone can mean landed; still persisted, or the review re-offers this delta forever.
                        if ((composed.landedTip ?? base) !== tip) {
                            next = { repo, base, landedTip: tip };
                            changed = true;
                        }
                        plans.push({ next });
                        continue;
                    }
                    changed = true;
                    const target = { main, repo, base, tip } satisfies RepoLandTarget;
                    // `apply --check` is context-based: a landed copy matches; an edit to the same lines refuses it.
                    const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.patch`);
                    if ((await writePatch(main, patchPath, [from, tip], git)) === 0) {
                        // Net-zero delta: nothing to apply, but the tip must advance or a future land re-reports it.
                        next = { repo, base, landedTip: tip };
                        plans.push({ next });
                        continue;
                    }
                    // `measure`: an outstanding delta stays on the branch; an already-landed match still advances.
                    if (mode === "measure") {
                        if (await applies(main, patchPath, "reverse", git)) {
                            next = await advancedRepo(target, git);
                            plans.push({ next });
                            continue;
                        }
                        // A delta that now applies retires the stored verdict; blocked paths report like the real gate.
                        if (rejudging && !(await applies(main, patchPath, "forward", git))) {
                            const report = await classifyDelta(main, from, tip, patchDir, repo, git);
                            if (report.blocked.length > 0) {
                                const mainBranch = await mainBranchOf(main, git);
                                conflicts.push({
                                    repo,
                                    paths: report.blocked,
                                    clean: report.clean.length,
                                    ...(mainBranch !== undefined ? { mainBranch } : {}),
                                });
                            }
                        }
                        held = true;
                        plans.push({ next });
                        continue;
                    }
                    if (!(await applies(main, patchPath, "forward", git))) {
                        const report = await classifyDelta(main, from, tip, patchDir, repo, git);
                        // Atomic failure can mean part is already landed: apply what's outstanding, advance regardless.
                        if (report.blocked.length === 0) {
                            plans.push({ next, write: { ...target, kind: "subset", from, changes: report.clean } });
                            continue;
                        }
                        // Three-way apply refuses outright on any workspace-dirty path; merge needs none of those.
                        const mergeable = report.blocked.every((conflict) => conflict.reason !== "workspace");
                        if (mode === "check" || !mergeable) {
                            // `check` promises a refusal leaves the workspace untouched; only `blocked` is reported.
                            const mainBranch = await mainBranchOf(main, git);
                            conflicts.push({
                                repo,
                                paths: report.blocked,
                                clean: report.clean.length,
                                ...(mainBranch !== undefined ? { mainBranch } : {}),
                            });
                            plans.push({ next });
                            continue;
                        }
                        // Queued: written only once every other repo also proves it can apply or produce markers.
                        plans.push({
                            next,
                            write: { ...target, kind: "merge", patchPath, paths: report.blocked.map((conflict) => conflict.path) },
                        });
                        continue;
                    }
                    plans.push({ next, write: { ...target, kind: "whole", patchPath } });
                }

                // A refusal returns the original repo records, so a later land still applies the whole composed change.
                if (conflicts.length > 0) {
                    return {
                        landed: false,
                        changed,
                        repos: [...entry.repos],
                        diff,
                        adjudicated: mode !== "measure" || rejudging,
                        conflicts,
                    };
                }

                // Phase two: preflight passed under held locks; apply every plan, then stamp every tip as one outcome.
                for (const plan of plans) {
                    if (plan.write === undefined) {
                        continue;
                    }
                    await applyRepoWrite(plan.write, patchDir, resolving, git);
                    plan.next = await advancedRepo(plan.write, git);
                }
                return {
                    landed: !held,
                    changed,
                    repos: plans.map(({ next }) => next),
                    diff,
                    adjudicated: mode !== "measure" || rejudging,
                    ...(resolving.length > 0 ? { resolving } : {}),
                    ...(held ? { held: true } : {}),
                };
            },
        );
    } finally {
        await rm(patchDir, { recursive: true, force: true });
    }
};

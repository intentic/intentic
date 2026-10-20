import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathExists } from "@intentic/base/fs";
import type { AgentSpan, LandConflict, LandConflictReason, LandMode, LandResult } from "@intentic/sandbox-contract/schemas/agents";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { headSha } from "../../git/changes/changes.js";
import { pruneEmptiedDirs } from "../../git/changes/changes-index.js";
import { parseNameStatusZ, parseNumstatZ, parseStatusV2 } from "../../git/changes/changes-porcelain.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import { agentRepoChanges, anchorOf } from "./agent-changes.js";
import { branchSha, mainBranchOf } from "../../git/agent-refs.js";
import { withConversationTrailer } from "../../git-identity.js";
import { writeChangesPatch, writePatch } from "./patch/land-patch.js";
import { reconcileLockfile } from "./lockfile-reconcile.js";
import { applies, changesByPath, changesNamedIn, type DeltaChange, deltaChangeOf, deltaChanges, gitSaid, refusal } from "./patch/apply-refusal.js";
import { type Rederived, rederiveAll, UNDERIVED } from "./rederive.js";
import { planThreeWay, type ThreeWay, unwrittenThreeWay, writeThreeWay } from "./patch/three-way.js";
import { opt } from "../../opt.js";
import type { IsolatedAgent, RepoRecord } from "../registry/agents-store.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import { assertLinked } from "../worktrees/checkout-link.js";

// Lands a conversation's work into the main tree as uncommitted changes: preserves worktree state as a commit on
// agent/<id>, then applies each repo's anchor..tip patch working-tree-only once every repo in the composition
// preflights clean. Content that already reached main another way is never a conflict. A spawned child's work lands
// the same way into its parent's own checkout instead (`into`, land-target.ts): the tree written into is the parent's,
// and what the delta is measured against stays the child's own anchor.
//
// A WRITE IS LANDED ONLY ONCE THE TREE IS READ BACK HOLDING IT (2026-10-20). Every door a land goes through (a turn's
// close, a press, a parent's `merge`, a wake that went away, a runner child) ends in `writePlans`, and there a repo's
// landed tip moves only on a proof read off the tree by content: the written patch now un-applies (its post-image is
// there), or the merge's result is what the tree holds, markers included. A write the tree did not take is that repo's
// conflict, with its tip where it was, so the branch keeps the work and no later catch-up can let it go as landed.

// Wire LandResult plus registry state: `repos` carries advanced landedTips, `diff` is the cumulative anchor->tip stat
// the review itself reads.
export interface LandOutcome extends LandResult {
    readonly repos: RepoRecord[];
    // The parent conversation whose checkout the work was written into instead of the main tree (land-target.ts).
    readonly into?: string;
    readonly diff: { files: number; insertions: number; deletions: number };
    // False unless a `measure` re-judged a stored refusal; true lets a fresh verdict replace a stale one.
    readonly adjudicated: boolean;
    // Repos whose lockfile could not be regenerated for a manifest the delta changed; the land went ahead without it.
    readonly lockfileFailures?: readonly LockfileFailure[];
    // What each written repo's own fixers derived again in the tree the land wrote into (rederive.ts).
    readonly derived?: readonly Rederived[];
    // A landed tip moved with nothing written: a net-zero delta (an edit and its revert). The books must keep it or a
    // later land re-reports the delta, but `changed` stays false: nothing reached a tree, so nothing is announced.
    readonly advanced?: true;
}

export interface LockfileFailure {
    readonly repo: string;
    readonly reason: string;
}

// Beyond this, a refusal is a workspace-sized decision. Thousands of per-file git probes would hold the repo lock
// for minutes; keep the paths (and therefore their count) in the existing conflict contract for the user to clear.
const MAX_REFUSED_FILES = 3_000;

// A delta's changes split by what main makes of each: `clean` is what a land would carry, `blocked` is a genuine
// conflict. Already-in-main changes are in neither.
interface DeltaReport {
    readonly blocked: { path: string; reason: LandConflictReason }[];
    readonly clean: DeltaChange[];
}


// Every path main's own tree has something uncommitted on, a rename's source leg included: a staged copy is as much at
// risk as an unstaged one. One status read; no line counts, which changedFiles would spend a read per untracked file on.
// `--no-optional-locks`: the standings probe calls this outside the repo lock, where writing index.lock would race a land.
export const dirtyPaths = async (main: string, git: GitRunner): Promise<ReadonlySet<string>> => {
    const { stdout } = await git(main, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "-uall", "--find-renames"]);
    const status = parseStatusV2(stdout);
    const dirty = new Set<string>(status.untracked);
    for (const change of [...status.conflicted, ...status.staged, ...status.unstaged]) {
        dirty.add(change.path);
        if (change.from !== undefined) {
            dirty.add(change.from);
        }
    }
    return dirty;
};

// The refusal names every file patch that failed, so the blocked set costs one read rather than a probe per change; a
// second, reversed check over that set alone drops content that reached main by another road. Two git runs for a delta
// of any size, where probing each change cost three per change.
const classifyDelta = async (
    main: string,
    from: string,
    tip: string,
    patchDir: string,
    repo: string,
    // What the whole patch's forward check said.
    refused: string,
    git: GitRunner,
): Promise<DeltaReport> => {
    const rows = parseNameStatusZ((await git(main, ["diff", "--name-status", "-z", "-M", from, tip, ...UNDERIVED])).stdout);
    const changes = rows.map(deltaChangeOf);
    // Numstat, not a patch string search: a binary file has both counts omitted, keyed on the destination path.
    const stats = parseNumstatZ((await git(main, ["diff", "--numstat", "-z", "-M", from, tip, ...UNDERIVED])).stdout);
    const isBinary = (path: string): boolean => {
        const counts = stats.get(path);
        return counts !== undefined && counts.additions === undefined && counts.deletions === undefined;
    };
    const mainDirty = await dirtyPaths(main, git);
    // Binary checked first: it outranks the other reasons, since no three-way merge of it exists.
    const reasonOf = (change: DeltaChange): LandConflictReason =>
        isBinary(change.path) ? "binary" : change.paths.some((path) => mainDirty.has(path)) ? "workspace" : "diverged";
    const named = changesNamedIn(refused, changesByPath(changes));
    const refusedChanges = named.size === 0 ? changes : [...named];
    if (refusedChanges.length > MAX_REFUSED_FILES) {
        const blocked = refusedChanges.map((change) => ({ path: change.path, reason: reasonOf(change) }));
        return { blocked, clean: named.size === 0 ? [] : changes.filter((change) => !named.has(change)) };
    }
    // A wording this reader could not place: each change probed alone, the road the named set otherwise makes unnecessary.
    if (named.size === 0) {
        return probeEach(main, from, tip, patchDir, repo, changes, reasonOf, git);
    }
    const probePath = join(patchDir, `${repo.replaceAll("/", "_")}.refused.patch`);
    const still =
        (await writeChangesPatch(main, probePath, from, tip, [...named], git)) === 0
            ? new Set<DeltaChange>()
            : await stillRefused(main, probePath, named, git);
    return {
        blocked: changes.filter((change) => still.has(change)).map((change) => ({ path: change.path, reason: reasonOf(change) })),
        clean: changes.filter((change) => !named.has(change)),
    };
};

// Of the refused changes, those main does not already hold: the reversed check names what would not un-apply. A refusal
// it cannot place keeps every one, since a change dropped here would land as clean and fail the write.
const stillRefused = async (main: string, probePath: string, named: ReadonlySet<DeltaChange>, git: GitRunner): Promise<ReadonlySet<DeltaChange>> => {
    const reversed = await refusal(main, probePath, "reverse", git);
    if (reversed === undefined) {
        return new Set();
    }
    const placed = changesNamedIn(reversed, changesByPath([...named]));
    return placed.size === 0 ? named : placed;
};

// Each change re-probed alone, over its whole path set so rename pairing stays correct; up to three git runs per change.
const probeEach = async (
    main: string,
    from: string,
    tip: string,
    patchDir: string,
    repo: string,
    changes: readonly DeltaChange[],
    reasonOf: (change: DeltaChange) => LandConflictReason,
    git: GitRunner,
): Promise<DeltaReport> => {
    const blocked: { path: string; reason: LandConflictReason }[] = [];
    const clean: DeltaChange[] = [];
    for (const [index, change] of changes.entries()) {
        const probePath = join(patchDir, `${repo.replaceAll("/", "_")}.probe.${index}.patch`);
        if ((await writeChangesPatch(main, probePath, from, tip, [change], git)) === 0 || (await applies(main, probePath, "forward", git))) {
            clean.push(change);
            continue;
        }
        if (await applies(main, probePath, "reverse", git)) {
            // Already in the main tree: not clean, not a conflict, simply drops out with nothing to report.
            continue;
        }
        blocked.push({ path: change.path, reason: reasonOf(change) });
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
): Promise<string | undefined> => {
    if (changes.length === 0) {
        return undefined;
    }
    const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.remainder.patch`);
    if ((await writeChangesPatch(main, patchPath, from, tip, changes, git)) === 0) {
        return undefined;
    }
    const removes = changes.flatMap((change) => change.removes);
    // `git apply` prunes what a patch removes itself; an explicit `rm` below leaves its parents for this.
    await git(main, ["apply", patchPath]);
    await Promise.all(
        // `force`: the path is already gone whenever the patch expressed its own removal.
        removes.map(async (path) => await rm(join(main, path), { force: true })),
    );
    await pruneEmptiedDirs(main, removes);
    return patchPath;
};

// Re-derives the stored conflict report live against today's tree, read-only: the stored report rots once the user
// commits or the main line moves past it. The stored event itself (what keeps the card on `conflict`) is untouched.
export const outstandingConflicts = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    // The parent whose checkout the work goes into, as the land itself would write it; undefined for the main tree.
    into: string | undefined = undefined,
    git: GitRunner = defaultGit,
): Promise<LandConflict[]> => {
    const conflicts: LandConflict[] = [];
    const patchDir = await mkdtemp(join(tmpdir(), "intentic-classify-"));
    try {
        for (const { repo, base, landedTip } of entry.placement.repos) {
            await worktrees.withRepoLock(repo, async () => {
                const main = into === undefined ? worktrees.mainDir(repo) : worktrees.worktreeDir(into, repo);
                if (!(await pathExists(join(main, ".git")))) {
                    // Vanished main checkout: reported the same way land itself reports it.
                    conflicts.push({ repo, paths: [], clean: 0 });
                    return;
                }
                const attached = await worktrees.attached(entry.id, repo);
                const worktree = worktrees.worktreeDir(entry.id, repo);
                const tip = attached ? (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim() : await branchSha(main, entry.placement.branch, git);
                if (tip === undefined) {
                    return;
                }
                const refDir = attached ? worktree : main;
                const from = await anchorOf(entry.placement, refDir, worktrees.mainDir(repo), tip, landedTip, base, git);
                if (tip === from) {
                    return;
                }
                const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.patch`);
                if ((await writePatch(main, patchPath, [from, tip, ...UNDERIVED], git)) === 0) {
                    return;
                }
                // Applies whole or already whole: nothing refuses today, whatever refused before.
                const refused = await refusal(main, patchPath, "forward", git);
                if (refused === undefined || (await applies(main, patchPath, "reverse", git))) {
                    return;
                }
                const report = await classifyDelta(main, from, tip, patchDir, repo, refused, git);
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
    // The checkout written into: the main tree's, or the parent's for a child landing into its parent.
    readonly main: string;
    readonly repo: string;
    readonly base: string;
    readonly tip: string;
    // The anchor the patch spans from; what a failed write is re-read against to name its paths.
    readonly from: string;
}

type RepoLandWrite =
    | (RepoLandTarget & { readonly kind: "whole"; readonly patchPath: string })
    | (RepoLandTarget & { readonly kind: "subset"; readonly changes: readonly DeltaChange[] })
    | (RepoLandTarget & { readonly kind: "merge"; readonly merge: ThreeWay });

interface RepoLandPlan {
    next: RepoRecord;
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

const advancedRepo = async (target: RepoLandTarget, git: GitRunner): Promise<RepoRecord> => {
    const landedHead = await headSha(target.main, git);
    return {
        repo: target.repo,
        base: target.base,
        landedTip: target.tip,
        ...(landedHead !== undefined ? { landedHead } : {}),
        landedAt: Date.now(),
    };
};

// Writes one repo's plan, answering the patch a `whole` or `subset` write applied (what its proof un-applies).
const applyRepoWrite = async (write: RepoLandWrite, patchDir: string, git: GitRunner): Promise<string | undefined> => {
    switch (write.kind) {
        case "whole":
            await git(write.main, ["apply", write.patchPath]);
            return write.patchPath;
        case "subset":
            return applyChanges(write.main, write.from, write.tip, write.changes, patchDir, write.repo, git);
        case "merge":
            await writeThreeWay(write.main, write.merge, join(patchDir, `${write.repo.replaceAll("/", "_")}.merge.patch`), git);
            return undefined;
    }
};

// The paths of a written plan the tree does not hold, read back by content; empty is the proof the land is there. A
// patch is there exactly when it un-applies, and a merge exactly when the tree reads as its result.
const unwrittenPaths = async (write: RepoLandWrite, applied: string | undefined, patchDir: string, git: GitRunner): Promise<string[]> => {
    if (write.kind === "merge") {
        return unwrittenThreeWay(write.main, write.merge, patchDir, write.repo.replaceAll("/", "_"), git);
    }
    const changes = write.kind === "subset" ? write.changes : await deltaChanges(write.main, write.from, write.tip, git);
    const gone = (
        await Promise.all(changes.flatMap((change) => change.removes).map(async (path) => ((await pathExists(join(write.main, path))) ? [path] : [])))
    ).flat();
    const reversed = applied === undefined ? undefined : await refusal(write.main, applied, "reverse", git);
    if (reversed === undefined) {
        return gone;
    }
    const named = changesNamedIn(reversed, changesByPath(changes));
    return [...new Set([...gone, ...(named.size === 0 ? changes : changes.filter((change) => named.has(change))).map((change) => change.path)])];
};

// The conflict a failed write amounts to, read off git's own message. `workspace`: the tree itself stood in the way
// (a directory where the patch puts a symlink), the one reason a person clears by hand. A message naming no path of the
// delta is nothing this can explain, and is rethrown.
const refusedWrite = async (write: RepoLandWrite, error: unknown, git: GitRunner): Promise<LandConflict> => {
    const changes = write.kind === "subset" ? write.changes : await deltaChanges(write.main, write.from, write.tip, git);
    const named = changesNamedIn(gitSaid(error), changesByPath(changes));
    if (named.size === 0) {
        throw error;
    }
    const mainBranch = await mainBranchOf(write.main, git);
    return {
        repo: write.repo,
        paths: changes.filter((change) => named.has(change)).map((change) => ({ path: change.path, reason: "workspace" as const })),
        clean: changes.length - named.size,
        ...(mainBranch !== undefined ? { mainBranch } : {}),
    };
};

// Everything one land holds constant across its repos; phase one reads it, phase two only the patch dir and runner.
interface LandRun {
    readonly worktrees: AgentWorktrees;
    readonly entry: IsolatedAgent;
    // The parent whose checkout takes the work instead of the main tree (land-target.ts).
    readonly into: string | undefined;
    readonly mode: LandMode;
    readonly span: AgentSpan;
    // Even a `measure` re-judges a stored refusal, or 'resolve' loops forever; only a verdict may replace a verdict.
    readonly rejudging: boolean;
    readonly patchDir: string;
    readonly git: GitRunner;
}

// What phase one decided about one repo.
interface RepoPlanning {
    readonly plan: RepoLandPlan;
    readonly conflict?: LandConflict;
    // A `measure` land deliberately left an outstanding delta on the branch.
    readonly held?: true;
    readonly changed: boolean;
    // The landed tip moves though nothing is written (LandOutcome.advanced).
    readonly advanced?: true;
    readonly diff: LandOutcome["diff"];
}

const conflictOf = async (main: string, repo: string, report: DeltaReport, git: GitRunner): Promise<LandConflict> => {
    const mainBranch = await mainBranchOf(main, git);
    return { repo, paths: report.blocked, clean: report.clean.length, ...(mainBranch !== undefined ? { mainBranch } : {}) };
};

// Lockfile fixed ahead of the locks, so manifest and lockfile still land as one commit: a resolution can run for minutes
// and touches only the worktree, and every repo's lock held through it would queue the board behind it.
const reconcileLockfiles = async ({ worktrees, entry, git }: LandRun): Promise<LockfileFailure[]> => {
    const failures: LockfileFailure[] = [];
    for (const composed of entry.placement.repos) {
        if (!(await worktrees.attached(entry.id, composed.repo))) {
            continue;
        }
        const reconciled = await reconcileLockfile(worktrees.worktreeDir(entry.id, composed.repo), composed.landedTip ?? composed.base, git);
        if (reconciled.outcome === "failed") {
            failures.push({ repo: composed.repo, reason: reconciled.reason });
        }
    }
    return failures;
};

// The branch tip to land, and where ref-only reads run: the worktree while attached, the main repo after. A retired
// checkout still holds the branch's work via the shared store: not 'nothing to land'. Undefined: no branch at all.
const tipOf = async ({ worktrees, entry, git }: LandRun, repo: string, main: string): Promise<{ tip: string; refDir: string } | undefined> => {
    const attached = await worktrees.attached(entry.id, repo);
    const worktree = worktrees.worktreeDir(entry.id, repo);
    if (!attached) {
        const tip = await branchSha(main, entry.placement.branch, git);
        return tip === undefined ? undefined : { tip, refDir: main };
    }
    // Stages staged/unstaged/untracked alike; a no-op when the only change is a nested repo's gitlink.
    await commitWorktreeRemainder(repo, worktree, withConversationTrailer(`Agent: ${entry.social.title?.text ?? entry.id}`, entry.id), worktrees.mainDir("root"), git);
    return { tip: (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim(), refDir: worktree };
};

// Totalled by the review's own reader, so the card's count can't disagree with the review.
const cumulativeDiff = async ({ worktrees, entry, git }: LandRun, composed: RepoRecord): Promise<LandOutcome["diff"]> => {
    const diff = { files: 0, insertions: 0, deletions: 0 };
    for (const change of await agentRepoChanges(worktrees, entry, composed, "cumulative", git)) {
        diff.files += 1;
        diff.insertions += change.additions ?? 0;
        diff.deletions += change.deletions ?? 0;
    }
    return diff;
};

// `measure`: an outstanding delta stays on the branch; an already-landed match still advances. A delta that now
// applies retires the stored verdict; blocked paths report like the real gate.
const measureRepo = async (
    { rejudging, patchDir, git }: LandRun,
    composed: RepoRecord,
    target: RepoLandTarget,
    patchPath: string,
): Promise<Pick<RepoPlanning, "plan" | "conflict" | "held">> => {
    const { main, repo, from, tip } = target;
    if (await applies(main, patchPath, "reverse", git)) {
        return { plan: { next: await advancedRepo(target, git) } };
    }
    const refused = rejudging ? await refusal(main, patchPath, "forward", git) : undefined;
    const report = refused === undefined ? undefined : await classifyDelta(main, from, tip, patchDir, repo, refused, git);
    if (report !== undefined && report.blocked.length > 0) {
        return { plan: { next: composed }, conflict: await conflictOf(main, repo, report, git), held: true };
    }
    return { plan: { next: composed }, held: true };
};

// The gate for a `check` or `merge` land: `apply --check` is context-based, so a landed copy matches and an edit to the
// same lines refuses it.
const judgeRepo = async (
    { mode, patchDir, git }: LandRun,
    composed: RepoRecord,
    target: RepoLandTarget,
    patchPath: string,
): Promise<Pick<RepoPlanning, "plan" | "conflict">> => {
    const { main, repo, from, tip } = target;
    const refused = await refusal(main, patchPath, "forward", git);
    if (refused === undefined) {
        return { plan: { next: composed, write: { ...target, kind: "whole", patchPath } } };
    }
    const report = await classifyDelta(main, from, tip, patchDir, repo, refused, git);
    // Atomic failure can mean part is already landed: apply what's outstanding, advance regardless.
    if (report.blocked.length === 0) {
        return { plan: { next: composed, write: { ...target, kind: "subset", changes: report.clean } } };
    }
    // `check` promises a refusal leaves the workspace untouched; only `blocked` is reported.
    if (mode === "check") {
        return { plan: { next: composed }, conflict: await conflictOf(main, repo, report, git) };
    }
    // A merge through the tree as it stands, uncommitted edits and renames included (patch/three-way.ts). What it cannot hand a
    // person as markers holds the repo off whole, named where the merge put it.
    const merged = await planThreeWay(main, from, tip, patchDir, repo.replaceAll("/", "_"), git);
    if (merged.kind === "held") {
        const reasons = new Map(report.blocked.map((conflict) => [conflict.path, conflict.reason]));
        const blocked = merged.paths.map((path) => ({ path, reason: reasons.get(path) ?? ("diverged" as const) }));
        return { plan: { next: composed }, conflict: await conflictOf(main, repo, { blocked, clean: report.clean }, git) };
    }
    // Queued: written only once every other repo also proves it can apply or produce markers.
    return { plan: { next: composed, write: { ...target, kind: "merge", merge: merged.merge } } };
};

// Phase one for one repo: read-only, decides what phase two writes.
const planRepo = async (run: LandRun, composed: RepoRecord): Promise<RepoPlanning> => {
    const { worktrees, git } = run;
    const { repo, base } = composed;
    // Where the main line is read, and the tree the patch is written into: the same checkout unless a child lands into
    // its parent's.
    const mainLine = worktrees.mainDir(repo);
    const main = run.into === undefined ? mainLine : worktrees.worktreeDir(run.into, repo);
    const none = { files: 0, insertions: 0, deletions: 0 };
    if (!(await pathExists(join(main, ".git")))) {
        // Vanished main checkout: surfaced as a conflict, not silently skipped.
        return { plan: { next: composed }, conflict: { repo, paths: [], clean: 0 }, changed: true, diff: none };
    }
    const found = await tipOf(run, repo, mainLine);
    if (found === undefined) {
        return { plan: { next: composed }, changed: false, diff: none };
    }
    const { tip, refDir } = found;
    const diff = await cumulativeDiff(run, composed);
    const from = await anchorOf(run.entry.placement, refDir, mainLine, tip, run.span === "cumulative" ? undefined : composed.landedTip, base, git);
    if (tip === from) {
        // Ancestry alone can mean landed; still persisted, or the review re-offers this delta forever. Nothing is written
        // by this land, so it is an advance of the books and never `changed`: a door that reads `changed` as "it is in
        // the tree now" would say so of a land that wrote nothing (a parent's second `merge`, 2026-10-20).
        const moved = (composed.landedTip ?? base) !== tip;
        return moved
            ? { plan: { next: { repo, base, landedTip: tip } }, changed: false, advanced: true, diff }
            : { plan: { next: composed }, changed: false, diff };
    }
    const target = { main, repo, base, tip, from } satisfies RepoLandTarget;
    const patchPath = join(run.patchDir, `${repo.replaceAll("/", "_")}.patch`);
    if ((await writePatch(main, patchPath, [from, tip, ...UNDERIVED], git)) === 0) {
        // Net-zero delta: nothing to apply, but the tip must advance or a future land re-reports it.
        return { plan: { next: { repo, base, landedTip: tip } }, changed: false, advanced: true, diff };
    }
    const judged = run.mode === "measure" ? await measureRepo(run, composed, target, patchPath) : await judgeRepo(run, composed, target, patchPath);
    return { ...judged, changed: true, diff };
};

// One planned write, then the proof it is there: the only place a repo's landed tip moves for something written. A
// write the tree refused, or took and does not hold, is that repo's conflict instead, its tip unmoved.
const landWrite = async (
    write: RepoLandWrite,
    patchDir: string,
    git: GitRunner,
): Promise<{ readonly landed: RepoRecord; readonly resolving?: string[] } | { readonly conflict: LandConflict }> => {
    let applied: string | undefined;
    try {
        applied = await applyRepoWrite(write, patchDir, git);
    } catch (error) {
        return { conflict: await refusedWrite(write, error, git) };
    }
    const unwritten = await unwrittenPaths(write, applied, patchDir, git);
    if (unwritten.length > 0) {
        const blocked = unwritten.map((path) => ({ path, reason: "workspace" as const }));
        return { conflict: await conflictOf(write.main, write.repo, { blocked, clean: [] }, git) };
    }
    const landed = await advancedRepo(write, git);
    return write.kind === "merge" && write.merge.conflicted.length > 0 ? { landed, resolving: [...write.merge.conflicted] } : { landed };
};

// Phase two: preflight passed under held locks; every plan written and proven, then every tip stamped as one outcome.
// A write that did not land ends the pass as that repo's conflict, the repos already landed keeping their advance,
// rather than as a throw that names nothing.
const writePlans = async (
    plans: readonly RepoLandPlan[],
    patchDir: string,
    git: GitRunner,
): Promise<{ repos: RepoRecord[]; conflicts: LandConflict[]; resolving: { repo: string; paths: string[] }[] }> => {
    const conflicts: LandConflict[] = [];
    // Filled only by a `merge` land.
    const resolving: { repo: string; paths: string[] }[] = [];
    for (const plan of plans) {
        if (plan.write === undefined) {
            continue;
        }
        const written = await landWrite(plan.write, patchDir, git);
        if ("conflict" in written) {
            conflicts.push(written.conflict);
            break;
        }
        plan.next = written.landed;
        if (written.resolving !== undefined) {
            resolving.push({ repo: plan.write.repo, paths: written.resolving });
        }
    }
    return { repos: plans.map(({ next }) => next), conflicts, resolving };
};

export const landAgent = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    mode: LandMode = "check",
    // 'outstanding' for automatic lands; 'cumulative' re-measures from base, the only rung that still sees a discard.
    span: AgentSpan = "outstanding",
    // The parent whose checkout takes the work instead of the main tree (land-target.ts); undefined for the main tree.
    into: string | undefined = undefined,
    git: GitRunner = defaultGit,
): Promise<LandOutcome> => {
    // Before anything is read: a checkout that no longer shares main's objects stops here with a plain reason.
    await assertLinked(worktrees, entry.id, entry.placement.repos);
    const run: LandRun = {
        worktrees,
        entry,
        into,
        mode,
        span,
        rejudging: mode === "measure" && (entry.landing.conflicts?.length ?? 0) > 0,
        // One temp dir for this run's patch files, removed whole in the finally.
        patchDir: await mkdtemp(join(tmpdir(), "intentic-land-")),
        git,
    };
    const adjudicated = mode !== "measure" || run.rejudging;
    try {
        const lockfileFailures = await reconcileLockfiles(run);
        const outcome = await withRepoLocks<LandOutcome>(
            worktrees,
            entry.placement.repos.map(({ repo }) => repo),
            async () => {
                // Phase one: read-only, computes every repo's plan; nothing is written if any repo conflicts.
                const plannings: RepoPlanning[] = [];
                for (const composed of entry.placement.repos) {
                    plannings.push(await planRepo(run, composed));
                }
                const diff = { files: 0, insertions: 0, deletions: 0 };
                for (const planning of plannings) {
                    diff.files += planning.diff.files;
                    diff.insertions += planning.diff.insertions;
                    diff.deletions += planning.diff.deletions;
                }
                const changed = plannings.some((planning) => planning.changed);
                // Only where nothing else moved: a land that also wrote is plainly `changed`, and records its tips anyway.
                const advanced = !changed && plannings.some((planning) => planning.advanced === true) ? { advanced: true as const } : {};
                const held = plannings.some((planning) => planning.held === true);
                const conflicts = plannings.flatMap((planning) => (planning.conflict === undefined ? [] : [planning.conflict]));
                // A refusal returns the original repo records, so a later land still applies the whole composed change.
                const target = into === undefined ? {} : { into };
                if (conflicts.length > 0) {
                    return { landed: false, changed, repos: [...entry.placement.repos], diff, adjudicated, conflicts, ...target };
                }
                const written = await writePlans(
                    plannings.map(({ plan }) => plan),
                    run.patchDir,
                    git,
                );
                const resolving = written.resolving.length > 0 ? { resolving: written.resolving } : {};
                if (written.conflicts.length > 0) {
                    return { landed: false, changed, repos: written.repos, diff, adjudicated: true, conflicts: written.conflicts, ...resolving, ...target };
                }
                // Every write went through, under the same locks: the tree it wrote derives its own files (rederive.ts).
                const derived = opt("derived", await rederiveAll(plannings.flatMap(({ plan }) => (plan.write === undefined ? [] : [plan.write])), git));
                return { landed: !held, changed, repos: written.repos, diff, adjudicated, ...advanced, ...resolving, ...(held ? { held: true } : {}), ...derived, ...target };
            },
        );
        return lockfileFailures.length === 0 ? outcome : { ...outcome, lockfileFailures };
    } finally {
        await rm(run.patchDir, { recursive: true, force: true });
    }
};

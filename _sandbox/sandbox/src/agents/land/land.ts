import { mkdtemp, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathExists } from "../../path-exists.js";
import type { AgentSpan, GitChange, LandConflict, LandConflictReason, LandMode, LandResult } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { headSha } from "../../git/changes/changes.js";
import { parseNameStatusZ, parseNumstatZ, parseStatusV2 } from "../../git/changes/changes-porcelain.js";
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

// `git apply --check`, the exit code as a throw: undefined when the patch applies, else the stderr, which names every
// file patch that failed since git checks the whole list before giving up. `reverse` tells a clash from content main
// already has: a patch un-applies cleanly exactly when its post-image is already there.
const refusal = async (main: string, patch: string, direction: "forward" | "reverse", git: GitRunner): Promise<string | undefined> => {
    try {
        await git(main, ["apply", "--check", ...(direction === "reverse" ? ["--reverse"] : []), patch]);
        return undefined;
    } catch (error) {
        return stderrOf(error);
    }
};

const applies = async (main: string, patch: string, direction: "forward" | "reverse", git: GitRunner): Promise<boolean> =>
    (await refusal(main, patch, direction, git)) === undefined;

// What git said, off the runner's rejection; the message itself when the throw carries no stderr.
const stderrOf = (error: unknown): string => {
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === "string" && stderr !== "" ? stderr : error instanceof Error ? error.message : String(error);
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

// How `git apply` names the file a refusal or a failed write is about, one line each, the path as the capture. A line
// none of these place is scanned for a known path instead, so an unknown wording still names what it names.
const REFUSAL_LINES: readonly RegExp[] = [
    /^error: patch failed: (.+):\d+$/,
    /^error: (.+): (?:patch does not apply|already exists in (?:working directory|index)|does not (?:exist|match) in index|No such file or directory|wrong type|has type \d+, expected \d+)$/,
    /^error: cannot apply binary patch to '(.+)' without full index line$/,
    /^error: (?:binary patch does not apply to|binary patch to) '(.+)'/,
    /^error: the patch applies to '(.+)' \(/,
    /^error: unable to (?:write|add|remove) file '(.+)'/,
    /^error: (?:cannot|could not) (?:open|read|stat) '(.+)'/,
];

// Where a path may sit in a message: after the start, a space or a quote, and before a colon, a quote, a space, a
// bracket or the end. Keeps `a.ts` from matching inside `ba.ts`.
const boundedAt = (line: string, path: string, at: number): boolean => {
    const before = at === 0 ? " " : line[at - 1];
    const after = at + path.length >= line.length ? " " : line[at + path.length];
    return (
        (before === " " || before === "'" || before === '"') && (after === " " || after === "'" || after === '"' || after === ":" || after === ")")
    );
};

// The changes a refusal names, matched by any of their paths (a rename is named on either leg). Empty when the message
// held nothing this reader could place, which callers treat as unknown, never as nothing.
const changesNamedIn = (stderr: string, byPath: ReadonlyMap<string, DeltaChange>): Set<DeltaChange> => {
    const named = new Set<DeltaChange>();
    for (const line of stderr.split("\n")) {
        const captured = REFUSAL_LINES.map((pattern) => pattern.exec(line)?.[1]).find((path) => path !== undefined && byPath.has(path));
        const placed = captured === undefined ? undefined : byPath.get(captured);
        if (placed !== undefined) {
            named.add(placed);
            continue;
        }
        if (!line.startsWith("error:")) {
            continue;
        }
        for (const [path, change] of byPath) {
            const at = line.indexOf(path);
            if (at !== -1 && boundedAt(line, path, at)) {
                named.add(change);
            }
        }
    }
    return named;
};

// Every path of a change set, each pointing back at its change; a rename answers on either leg.
const changesByPath = (changes: readonly DeltaChange[]): Map<string, DeltaChange> => {
    const byPath = new Map<string, DeltaChange>();
    for (const change of changes) {
        for (const path of change.paths) {
            byPath.set(path, change);
        }
    }
    return byPath;
};

// Every path main's own tree has something uncommitted on, a rename's source leg included: a staged copy is as much at
// risk as an unstaged one. One status read; no line counts, which changedFiles would spend a read per untracked file on.
const dirtyPaths = async (main: string, git: GitRunner): Promise<ReadonlySet<string>> => {
    const status = parseStatusV2((await git(main, ["status", "--porcelain=v2", "-z", "--branch", "-uall", "--find-renames"])).stdout);
    const dirty = new Set<string>(status.untracked);
    for (const change of [...status.conflicted, ...status.staged, ...status.unstaged]) {
        dirty.add(change.path);
        if (change.from !== undefined) {
            dirty.add(change.from);
        }
    }
    return dirty;
};

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
    const rows = parseNameStatusZ((await git(main, ["diff", "--name-status", "-z", "-M", from, tip])).stdout);
    const changes = rows.map(deltaChangeOf);
    // Numstat, not a patch string search: a binary file has both counts omitted, keyed on the destination path.
    const stats = parseNumstatZ((await git(main, ["diff", "--numstat", "-z", "-M", from, tip])).stdout);
    const isBinary = (path: string): boolean => {
        const counts = stats.get(path);
        return counts !== undefined && counts.additions === undefined && counts.deletions === undefined;
    };
    const mainDirty = await dirtyPaths(main, git);
    // Binary checked first: it outranks the other reasons, since no three-way merge of it exists.
    const reasonOf = (change: DeltaChange): LandConflictReason =>
        isBinary(change.path) ? "binary" : change.paths.some((path) => mainDirty.has(path)) ? "workspace" : "diverged";
    const named = changesNamedIn(refused, changesByPath(changes));
    // A wording this reader could not place: each change probed alone, the road the named set otherwise makes unnecessary.
    if (named.size === 0) {
        return probeEach(main, from, tip, patchDir, repo, changes, reasonOf, git);
    }
    const probePath = join(patchDir, `${repo.replaceAll("/", "_")}.refused.patch`);
    const still =
        (await writePatch(main, probePath, [from, tip, "--", ...[...named].flatMap((change) => change.paths)], git)) === 0
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
        if ((await writePatch(main, probePath, [from, tip, "--", ...change.paths], git)) === 0 || (await applies(main, probePath, "forward", git))) {
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

// The conflict a failed write amounts to, read off git's own message. `workspace`: the tree itself stood in the way
// (a directory where the patch puts a symlink), the one reason a person clears by hand. A message naming no path of the
// delta is nothing this can explain, and is rethrown.
const refusedWrite = async (write: RepoLandWrite, error: unknown, git: GitRunner): Promise<LandConflict> => {
    const changes =
        write.kind === "subset"
            ? write.changes
            : parseNameStatusZ((await git(write.main, ["diff", "--name-status", "-z", "-M", write.from, write.tip])).stdout).map(deltaChangeOf);
    const named = changesNamedIn(stderrOf(error), changesByPath(changes));
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
    readonly diff: LandOutcome["diff"];
}

const conflictOf = async (main: string, repo: string, report: DeltaReport, git: GitRunner): Promise<LandConflict> => {
    const mainBranch = await mainBranchOf(main, git);
    return { repo, paths: report.blocked, clean: report.clean.length, ...(mainBranch !== undefined ? { mainBranch } : {}) };
};

// Lockfile fixed ahead of the locks, so manifest and lockfile still land as one commit: a resolution can run for minutes
// and touches only the worktree, and every repo's lock held through it would queue the board behind it.
const reconcileLockfiles = async ({ worktrees, entry, git }: LandRun): Promise<void> => {
    for (const composed of entry.repos) {
        if (await worktrees.attached(entry.id, composed.repo)) {
            await reconcileLockfile(worktrees.worktreeDir(entry.id, composed.repo), composed.landedTip ?? composed.base, git);
        }
    }
};

// The branch tip to land, and where ref-only reads run: the worktree while attached, the main repo after. A retired
// checkout still holds the branch's work via the shared store: not 'nothing to land'. Undefined: no branch at all.
const tipOf = async ({ worktrees, entry, git }: LandRun, repo: string, main: string): Promise<{ tip: string; refDir: string } | undefined> => {
    const attached = await worktrees.attached(entry.id, repo);
    const worktree = worktrees.worktreeDir(entry.id, repo);
    if (!attached) {
        const tip = await branchSha(main, entry.branch, git);
        return tip === undefined ? undefined : { tip, refDir: main };
    }
    // Stages staged/unstaged/untracked alike; a no-op when the only change is a nested repo's gitlink.
    await commitWorktreeRemainder(repo, worktree, `Agent: ${entry.title ?? entry.id}`, git);
    return { tip: (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim(), refDir: worktree };
};

// Totalled by the review's own reader, so the card's count can't disagree with the review.
const cumulativeDiff = async ({ worktrees, entry, git }: LandRun, composed: PersistedAgent["repos"][number]): Promise<LandOutcome["diff"]> => {
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
    composed: PersistedAgent["repos"][number],
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
    composed: PersistedAgent["repos"][number],
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
    // Three-way apply refuses outright on any workspace-dirty path; merge needs none of those. `check` promises a
    // refusal leaves the workspace untouched; only `blocked` is reported.
    if (mode === "check" || report.blocked.some((conflict) => conflict.reason === "workspace")) {
        return { plan: { next: composed }, conflict: await conflictOf(main, repo, report, git) };
    }
    // Queued: written only once every other repo also proves it can apply or produce markers.
    return { plan: { next: composed, write: { ...target, kind: "merge", patchPath, paths: report.blocked.map((conflict) => conflict.path) } } };
};

// Phase one for one repo: read-only, decides what phase two writes.
const planRepo = async (run: LandRun, composed: PersistedAgent["repos"][number]): Promise<RepoPlanning> => {
    const { worktrees, git } = run;
    const { repo, base } = composed;
    const main = worktrees.mainDir(repo);
    const none = { files: 0, insertions: 0, deletions: 0 };
    if (!(await pathExists(join(main, ".git")))) {
        // Vanished main checkout: surfaced as a conflict, not silently skipped.
        return { plan: { next: composed }, conflict: { repo, paths: [], clean: 0 }, changed: true, diff: none };
    }
    const found = await tipOf(run, repo, main);
    if (found === undefined) {
        return { plan: { next: composed }, changed: false, diff: none };
    }
    const { tip, refDir } = found;
    const diff = await cumulativeDiff(run, composed);
    const from = await anchorOf(refDir, main, tip, run.span === "cumulative" ? undefined : composed.landedTip, base, git);
    if (tip === from) {
        // Ancestry alone can mean landed; still persisted, or the review re-offers this delta forever.
        const landed = (composed.landedTip ?? base) !== tip;
        return { plan: { next: landed ? { repo, base, landedTip: tip } : composed }, changed: landed, diff };
    }
    const target = { main, repo, base, tip, from } satisfies RepoLandTarget;
    const patchPath = join(run.patchDir, `${repo.replaceAll("/", "_")}.patch`);
    if ((await writePatch(main, patchPath, [from, tip], git)) === 0) {
        // Net-zero delta: nothing to apply, but the tip must advance or a future land re-reports it.
        return { plan: { next: { repo, base, landedTip: tip } }, changed: true, diff };
    }
    const judged = run.mode === "measure" ? await measureRepo(run, composed, target, patchPath) : await judgeRepo(run, composed, target, patchPath);
    return { ...judged, changed: true, diff };
};

// Phase two: preflight passed under held locks; every plan written, then every tip stamped as one outcome. A write its
// preflight passed and the tree still refused ends the pass as that repo's conflict, the repos already written keeping
// their advance, rather than as a throw that names nothing.
const writePlans = async (
    plans: readonly RepoLandPlan[],
    patchDir: string,
    git: GitRunner,
): Promise<{ repos: PersistedAgent["repos"]; conflicts: LandConflict[]; resolving: { repo: string; paths: string[] }[] }> => {
    const conflicts: LandConflict[] = [];
    // Filled only by a `merge` land.
    const resolving: { repo: string; paths: string[] }[] = [];
    for (const plan of plans) {
        if (plan.write === undefined) {
            continue;
        }
        try {
            await applyRepoWrite(plan.write, patchDir, resolving, git);
        } catch (error) {
            conflicts.push(await refusedWrite(plan.write, error, git));
            break;
        }
        plan.next = await advancedRepo(plan.write, git);
    }
    return { repos: plans.map(({ next }) => next), conflicts, resolving };
};

export const landAgent = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    mode: LandMode = "check",
    // 'outstanding' for automatic lands; 'cumulative' re-measures from base, the only rung that still sees a discard.
    span: AgentSpan = "outstanding",
    git: GitRunner = defaultGit,
): Promise<LandOutcome> => {
    const run: LandRun = {
        worktrees,
        entry,
        mode,
        span,
        rejudging: mode === "measure" && (entry.conflicts?.length ?? 0) > 0,
        // One temp dir for this run's patch files, removed whole in the finally.
        patchDir: await mkdtemp(join(tmpdir(), "intentic-land-")),
        git,
    };
    const adjudicated = mode !== "measure" || run.rejudging;
    try {
        await reconcileLockfiles(run);
        return await withRepoLocks(
            worktrees,
            entry.repos.map(({ repo }) => repo),
            async () => {
                // Phase one: read-only, computes every repo's plan; nothing is written if any repo conflicts.
                const plannings: RepoPlanning[] = [];
                for (const composed of entry.repos) {
                    plannings.push(await planRepo(run, composed));
                }
                const diff = { files: 0, insertions: 0, deletions: 0 };
                for (const planning of plannings) {
                    diff.files += planning.diff.files;
                    diff.insertions += planning.diff.insertions;
                    diff.deletions += planning.diff.deletions;
                }
                const changed = plannings.some((planning) => planning.changed);
                const held = plannings.some((planning) => planning.held === true);
                const conflicts = plannings.flatMap((planning) => (planning.conflict === undefined ? [] : [planning.conflict]));
                // A refusal returns the original repo records, so a later land still applies the whole composed change.
                if (conflicts.length > 0) {
                    return { landed: false, changed, repos: [...entry.repos], diff, adjudicated, conflicts };
                }
                const written = await writePlans(
                    plannings.map(({ plan }) => plan),
                    run.patchDir,
                    git,
                );
                const resolving = written.resolving.length > 0 ? { resolving: written.resolving } : {};
                if (written.conflicts.length > 0) {
                    return { landed: false, changed, repos: written.repos, diff, adjudicated: true, conflicts: written.conflicts, ...resolving };
                }
                return { landed: !held, changed, repos: written.repos, diff, adjudicated, ...resolving, ...(held ? { held: true } : {}) };
            },
        );
    } finally {
        await rm(run.patchDir, { recursive: true, force: true });
    }
};

import type { AgentSpan, GitChange, WorkspaceModule } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { changesAgainstBase, changesBetweenRefs, headSha } from "../../git/changes/changes.js";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";
import { refAgainstRef, withCodeCounts, worktreeAgainstRef } from "../../git/changes/code-counts.js";
import { readModules } from "../../workspace/deps/modules.js";
import type { IsolatedAgent, PersistedAgent } from "../registry/agents-store.js";
import { isAncestor } from "./agent-refs.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// Single source for an agent's changed-lines count, shared by the review's live diff and the fleet card's snapshot
// taken at each land, so both report the same number.

// Anchor for measuring an agent's delta: `landedTip` for the incremental remainder, otherwise merge-base with main.
// The frozen creation-time base is only a last resort; a rebase invalidates it while merge-base moves with the sync.
export const anchorOf = async (
    // Worktree while the checkout is attached, main repo once retired; the object store is shared either way.
    dir: string,
    main: string,
    tip: string,
    landedTip: string | undefined,
    base: string,
    git: GitRunner = defaultGit,
): Promise<string> => {
    const head = await headSha(main, git);
    let merged = "";
    if (head !== undefined) {
        try {
            merged = (await git(dir, ["merge-base", head, tip])).stdout.trim();
        } catch {
            // Unrelated histories: no merge-base exists.
        }
    }
    // Valid only while the branch descends from landedTip and merge-base sits behind it; otherwise merge-base wins.
    if (landedTip !== undefined && (await isAncestor(dir, landedTip, tip, git))) {
        if (merged === "" || (await isAncestor(dir, merged, landedTip, git))) {
            return landedTip;
        }
        return merged;
    }
    return merged === "" ? base : merged;
};

// Compares trees, not shas: a rebase can leave two commits that cancel out with nothing changed, and this reads the
// same answer `git diff` would give.
export const carriesContent = async (dir: string, from: string, tip: string, git: GitRunner = defaultGit): Promise<boolean> => {
    if (from === tip) {
        return false;
    }
    try {
        const [fromTree, tipTree] = (await git(dir, ["rev-parse", `${from}^{tree}`, `${tip}^{tree}`])).stdout.trim().split("\n");
        return fromTree === undefined || tipTree === undefined || fromTree !== tipTree;
    } catch {
        // An unresolvable sha is not an emptiness claim; report content as changed and let land surface the real error.
        return true;
    }
};

// One repo's changes in the shape the Changes panel renders, from the checkout when attached or the two main-repo refs
// otherwise, decided by attachment rather than archivedAt.
export const agentRepoChanges = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    span: AgentSpan,
    git: GitRunner = defaultGit,
): Promise<GitChange[]> => {
    const { dir, attached, from } = await agentRepoScope(worktrees, entry, composed, span, git);
    return attached ? changesAgainstBase(dir, from, git) : changesBetweenRefs(worktrees.mainDir(composed.repo), from, entry.branch, git);
};

// Resolves the checkout/main repo and delta anchor together, so the two answers cannot diverge.
const agentRepoScope = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    span: AgentSpan,
    git: GitRunner,
): Promise<{ dir: string; attached: boolean; from: string }> => {
    const main = worktrees.mainDir(composed.repo);
    const attached = await worktrees.attached(entry.id, composed.repo);
    const dir = attached ? worktrees.worktreeDir(entry.id, composed.repo) : main;
    return {
        dir,
        attached,
        from: await anchorOf(dir, main, entry.branch, span === "outstanding" ? composed.landedTip : undefined, composed.base, git),
    };
};

// Same cumulative rows as the review, each carrying the code-only +/- count from git/code-counts.ts.
// Only the review pays for this; the fleet card sums git's own totals instead of walking every file's tokens.
export const agentRepoReview = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    git: GitRunner = defaultGit,
): Promise<GitChange[]> => {
    const { dir, attached, from } = await agentRepoScope(worktrees, entry, composed, "cumulative", git);
    const main = worktrees.mainDir(composed.repo);
    const changes = attached ? await changesAgainstBase(dir, from, git) : await changesBetweenRefs(main, from, entry.branch, git);
    return attached ? withCodeCounts(dir, changes, worktreeAgainstRef(dir, from)) : withCodeCounts(main, changes, refAgainstRef(from, entry.branch));
};

// What the main tree currently holds for each path, not a diff between two shas: a land copies content into the main
// working tree without moving any ref, so a sha-based delta cannot tell accepted, kept-uncommitted, and discarded
// apart.
// - absorbed: main's HEAD already holds this content; no longer a difference.
// - inWorkspace: the main working tree holds it, committed or not; the review's `landed`.
// - neither: discarded, reverted, or never landed; what remains for `Land now`.
export interface MainPresence {
    // Paths whose content main's history already carries; no longer a difference against main.
    readonly absorbed: ReadonlySet<string>;
    // Paths the main working tree holds right now, committed or not; the review's `landed`.
    readonly inWorkspace: ReadonlySet<string>;
}

const NO_PATHS: ReadonlySet<string> = new Set();

// One `-z` listing as a set, with each path copied out of git's stdout via materializedPaths, since a sliced string
// would pin the whole buffer.
const pathSet = async (dir: string, args: readonly string[], git: GitRunner): Promise<ReadonlySet<string>> =>
    new Set(materializedPaths((await git(dir, args)).stdout));

// Matches untracked paths against the branch tree by content, since `git diff` misses untracked files and name alone
// would misclassify a rewritten one; a hash mismatch stays outstanding, never falsely absorbed.
const HASH_CHUNK = 100;
const untrackedMatches = async (main: string, tip: string, paths: readonly string[], git: GitRunner): Promise<ReadonlySet<string>> => {
    const matched = new Set<string>();
    for (let cursor = 0; cursor < paths.length; cursor += HASH_CHUNK) {
        const batch = paths.slice(cursor, cursor + HASH_CHUNK);
        try {
            // `ls-tree` answers only for paths in the tree; a path the branch lacks comes back absent, not a failure.
            const [onDisk, inTree] = await Promise.all([
                git(main, ["hash-object", "--", ...batch]),
                git(main, ["ls-tree", "-z", "--full-name", tip, "--", ...batch]),
            ]);
            const hashes = onDisk.stdout.trim().split("\n");
            const tree = new Map(
                materializedPaths(inTree.stdout).map((record) => {
                    // `<mode> SP <type> SP <sha> TAB <path>`
                    const tab = record.indexOf("\t");
                    return [record.slice(tab + 1), record.slice(0, tab).split(" ")[2] ?? ""] as const;
                }),
            );
            for (const [index, path] of batch.entries()) {
                const hash = hashes[index];
                if (hash !== undefined && hash !== "" && tree.get(path) === hash) {
                    matched.add(path);
                }
            }
        } catch {
            // A vanished file or bad ref leaves this batch reported as outstanding, not falsely absorbed.
        }
    }
    return matched;
};

// Nothing known: every row differs, none is in the tree; the safe answer when the probe could not run.
const NOTHING: MainPresence = { absorbed: NO_PATHS, inWorkspace: NO_PATHS };

// Probes main for path presence; on any read failure it must not silently answer as if it had looked, and fails to the
// safe side: every row kept, none marked absorbed, since a Land-now no-op costs nothing.
export const presentInMain = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    paths: readonly string[],
    git: GitRunner = defaultGit,
): Promise<MainPresence> => {
    if (paths.length === 0) {
        return NOTHING;
    }
    try {
        return await probeMain(worktrees, entry, composed, paths, git);
    } catch {
        return NOTHING;
    }
};

const probeMain = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    paths: readonly string[],
    git: GitRunner,
): Promise<MainPresence> => {
    const main = worktrees.mainDir(composed.repo);
    const own = new Set(paths);
    // Not in `tip`: comparisons against it would misread uncommitted work, so mid-write paths stay outstanding.
    const dir = worktrees.worktreeDir(entry.id, composed.repo);
    const midWrite = !(await worktrees.attached(entry.id, composed.repo))
        ? NO_PATHS
        : new Set([
              ...(await pathSet(dir, ["diff", "--name-only", "--no-renames", "-z", "HEAD"], git)),
              ...(await pathSet(dir, ["ls-files", "--others", "--exclude-standard", "-z"], git)),
          ]);

    const head = await headSha(main, git);
    // `--no-renames`: the rows this joins onto use rename detection and key by destination path, as these do too.
    const [vsHead, vsWorktree] = await Promise.all([
        // Against main's history; an unborn main holds nothing, so nothing can be absorbed yet.
        head === undefined
            ? Promise.resolve(new Set(paths) as ReadonlySet<string>)
            : pathSet(main, ["diff", "--name-only", "--no-renames", "-z", head, entry.branch], git),
        // Against main's index and working tree, where a land leaves its content.
        pathSet(main, ["diff", "--name-only", "--no-renames", "-z", entry.branch], git),
    ]);

    const untracked = await pathSet(main, ["ls-files", "--others", "--exclude-standard", "-z"], git);
    const blind = [...vsWorktree].filter((path) => own.has(path) && untracked.has(path));
    const materialized = blind.length === 0 ? NO_PATHS : await untrackedMatches(main, entry.branch, blind, git);
    return verdicts(own, { midWrite, vsHead, vsWorktree, materialized });
};

// Decides the three states per path from the four listings above; absorbed implies in-workspace since main history
// holding the content is the strongest signal, surviving a later user edit.
const verdicts = (
    own: ReadonlySet<string>,
    listings: { midWrite: ReadonlySet<string>; vsHead: ReadonlySet<string>; vsWorktree: ReadonlySet<string>; materialized: ReadonlySet<string> },
): MainPresence => {
    const absorbed = new Set<string>();
    const inWorkspace = new Set<string>();
    for (const path of own) {
        if (listings.midWrite.has(path)) {
            continue;
        }
        if (!listings.vsHead.has(path)) {
            absorbed.add(path);
        }
        if (!listings.vsHead.has(path) || !listings.vsWorktree.has(path) || listings.materialized.has(path)) {
            inWorkspace.add(path);
        }
    }
    return { absorbed, inWorkspace };
};

// Reads package layout from the same tree the changes were read from, since the workspace-wide reader only sees /work;
// a retired checkout falls back to the main repo, matching the file diff beside it.
export const agentRepoModules = async (worktrees: AgentWorktrees, entry: IsolatedAgent, repo: string): Promise<WorkspaceModule[]> =>
    readModules((await worktrees.attached(entry.id, repo)) ? worktrees.worktreeDir(entry.id, repo) : worktrees.mainDir(repo));

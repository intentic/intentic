import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathExists } from "../path-exists.js";
import {
    type FileDiff,
    type Snapshot,
    type SnapshotChange,
    SnapshotTriggerSchema,
    type SnapshotTrigger,
    VERSIONED_STATE_PATHS,
} from "@intentic/sandbox-contract";
import { STATE_DIR } from "@intentic/constants";
import { IGNORED_DIRS, REFERENCE_DIR } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import { MAX_FILE_DIFF_BYTES, partialDiff } from "../git/changes/diff-partial.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { discoverRepos, hasGitEntry, isValidRepoId } from "../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

// Daemon-owned workspace history: each scope (/work root or a discovered repo) gets a bare git dir under
// <historyRoot>/scopes via a private index; the agent's repos, branches and HEAD are never touched. The timeline shows
// only turn/user/pre-restore/restore snapshots; a checkpoint diffs against the previous visible one, not its raw
// parent.

const exec = promisify(execFile);

const SNAPSHOT_INTERVAL_MS = 60_000;
// Trailing debounce for user-write pings; coalesces a multi-file drop into one snapshot.
const USER_WRITE_DEBOUNCE_MS = 2_000;
// The triggers that surface as timeline checkpoints; "interval" captures are hidden safety sweeps.
const VISIBLE_TRIGGERS: ReadonlySet<SnapshotTrigger> = new Set(["turn", "user", "pre-restore", "restore"]);
const MAX_LABEL_LENGTH = 160;
// git's empty-tree hash; the diff base for a scope's first snapshot (also an unborn HEAD in git/changes.ts).
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Runs git with the scope's detached-worktree env; injectable so command sequences are unit-testable without a real
// repo.
export type HistoryGitRunner = (
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;
const defaultRunner: HistoryGitRunner = (args, options) =>
    exec("git", [...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, maxBuffer: 8 * 1024 * 1024 });

// Real git dir for a daemon-created repo, passed to --separate-git-dir so the in-worktree .git is a rewritable pointer.
// Dir name is the URI-encoded repo id, one filesystem entry per (possibly nested) id.
export const repoGitDir = (historyRoot: string, name: string): string => join(historyRoot, "gits", encodeURIComponent(name));

// Secret/junk patterns every scope excludes; unanchored, appended after the carve-outs, so they always win.
const COMMON_PRIVATE_FILES = new Set([".secrets.json", "claude.json"]);
// Written without the trailing slash: a directory-only rule does not match a SYMLINK of that name, and an agent's
// worktree mirrors these dirs in as symlinks. It also matches rootPathIsExcluded below, which has always gone by name.
const COMMON_EXCLUDES = [".env*", "!.env.example", ...COMMON_PRIVATE_FILES, ...IGNORED_DIRS];

// Executable form of rootExcludes, for a caller with a path rather than a gitignore engine (rejects an incoming tracked
// path before checkout).
const isVersionedStatePath = (path: string): boolean =>
    VERSIONED_STATE_PATHS.some((allowed) => (allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed));

export const rootPathIsExcluded = (path: string, repoIds: readonly string[]): boolean => {
    const segments = path.split("/");
    if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        return true;
    }
    if (repoIds.some((id) => path === id || path.startsWith(`${id}/`))) {
        return true;
    }
    if (segments[0] === REFERENCE_DIR) {
        return true;
    }
    if (segments[0] === STATE_DIR && !isVersionedStatePath(path)) {
        return true;
    }
    return segments.some(
        (segment) => IGNORED_DIRS.has(segment) || (segment.startsWith(".env") && segment !== ".env.example") || COMMON_PRIVATE_FILES.has(segment),
    );
};
// Root scope also excludes every discovered repo dir, /.intentic/ (daemon-internal state) and /refs/ (reference shelf);
// derived from the live repo set since repos can appear anywhere under /work.
export const rootExcludes = (repoIds: readonly string[]): string[] => [
    ...repoIds.map((id) => `/${id}/`),
    // Excludes /.intentic's children, not the directory, so the negations below can re-include specific files.
    ...trackedStateExcludes(),
    `/${REFERENCE_DIR}/`,
    ...COMMON_EXCLUDES,
];

// Un-ignores each ancestor of a tracked path then re-excludes its contents, one rung per nesting level: git's
// exclude-directory rule blocks re-inclusion below an excluded dir otherwise.
const trackedStateExcludes = (): string[] => {
    const walkable = new Set<string>();
    for (const path of VERSIONED_STATE_PATHS) {
        const segments = path.replace(/\/$/, "").split("/");
        // Every ancestor from the state dir down to (but not including) the entry itself.
        for (let depth = 1; depth < segments.length; depth++) {
            walkable.add(segments.slice(0, depth).join("/"));
        }
    }
    // Shallowest first: a later rule wins in git, so each level must be opened before the next one is closed.
    const ladder = [...walkable].toSorted((a, b) => a.split("/").length - b.split("/").length);
    return [
        ...ladder.flatMap((dir, index) => (index === 0 ? [`/${dir}/*`] : [`!/${dir}/`, `/${dir}/*`])),
        ...VERSIONED_STATE_PATHS.map((path) => `!/${path}`),
    ];
};

// Converges the root exclude list onto both consumers (the /work repo's git dir and the history root scope) so history
// and the Changes review agree; skips a target whose git dir does not exist yet.
export const syncRootExcludes = async (historyRoot: string, repoIds: readonly string[]): Promise<void> => {
    const content = `${rootExcludes(repoIds).join("\n")}\n`;
    for (const gitDir of [repoGitDir(historyRoot, "root"), join(historyRoot, "scopes", "root.git")]) {
        try {
            await access(join(gitDir, "info"));
        } catch {
            continue;
        }
        const target = join(gitDir, "info", "exclude");
        if ((await readFile(target, "utf8").catch(() => undefined)) !== content) {
            await writeFile(target, content);
        }
    }
};

export interface WorkspaceHistory {
    readonly start: () => void;
    readonly stop: () => void;
    // Returns the snapshot id, or undefined if nothing changed; a label becomes the checkpoint's timeline title.
    readonly snapshot: (trigger: SnapshotTrigger, label?: string) => Promise<string | undefined>;
    // Ping from a user write route; trailing-debounced into one snapshot("user") per user gesture.
    readonly notifyUserWrite: () => void;
    readonly list: () => Promise<Snapshot[]>;
    // undefined means an unknown snapshot id (mapped to NOT_FOUND by routes); otherwise what changed vs the parent.
    readonly diff: (id: string) => Promise<SnapshotChange[] | undefined>;
    readonly fileDiff: (id: string, scope: string, path: string) => Promise<FileDiff | undefined>;
    // Bare repo dir + rev-spec for a diff side's raw bytes (images fileDiff can't ship); undefined if unknown.
    readonly fileBlob: (id: string, scope: string, path: string, side: "before" | "after") => Promise<{ dir: string; spec: string } | undefined>;
    readonly restore: (id: string) => Promise<boolean>;
}

interface Scope {
    // "root" or a repo id (root-relative dir, e.g. "clients/foo"); the wire-visible scope name.
    readonly name: string;
    readonly gitDir: string;
    readonly worktree: string;
}

interface ScopeCommit {
    readonly sha: string;
    // Committer time, ms.
    readonly at: number;
    readonly id: string;
    readonly trigger: SnapshotTrigger;
    readonly label?: string;
}

// Labels live in commit bodies from free-form prompts; collapsed to one bounded line for git log parsing and the
// timeline row.
const sanitizeLabel = (label: string): string | undefined => {
    const clean = label
        .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, MAX_LABEL_LENGTH);
    return clean === "" ? undefined : clean;
};

// Env for every worktree-touching command; the private index keeps the agent's repos untouched and repeat scans
// stat-only. cwd must be the worktree.
const scopeEnv = (scope: Scope): Record<string, string> => ({
    GIT_DIR: scope.gitDir,
    GIT_WORK_TREE: scope.worktree,
    GIT_INDEX_FILE: join(scope.gitDir, "snapshot.index"),
});

// Cheap gate before deletionState: ignored entries (node_modules, dist, .git pointer) survive a real delete, so
// emptiness alone doesn't prove one.
const looksEmptied = async (worktree: string): Promise<boolean> => {
    const entries = await readdir(worktree, { withFileTypes: true }).catch(() => []);
    return entries.every((entry) => entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name));
};

// One side of a checkpoint's file diff, as fileAt reports it.
interface CheckpointSide {
    readonly content?: string;
    readonly binary?: boolean;
    readonly bytes?: number;
}

// True when a side is present, not binary, but has no content: sized but over the cap to read; its diff ships as a
// patch of the changed regions instead of two whole sides.
const overCap = (side: CheckpointSide | undefined): boolean =>
    side !== undefined && side.bytes !== undefined && side.content === undefined && side.binary !== true;

export const createWorkspaceHistory = (
    options: { readonly workspace: WorkspacePaths; readonly historyRoot: string; readonly logger: Logger },
    git: HistoryGitRunner = defaultRunner,
): WorkspaceHistory => {
    const { workspace, historyRoot, logger } = options;
    const scopesRoot = join(historyRoot, "scopes");

    // Git dir name is the URI-encoded scope name; a nested repo id's slashes become %2F so each scope stays one
    // filesystem entry.
    const scopeOf = (name: string): Scope => ({
        name,
        gitDir: join(scopesRoot, `${encodeURIComponent(name)}.git`),
        worktree: name === "root" ? workspace.root : join(workspace.root, name),
    });

    // Tree-to-tree ops (log/diff-tree/cat-file) need no worktree, they must work after a repo is deleted.
    const bare = (scope: Scope): { cwd: string; env: Record<string, string> } => ({ cwd: historyRoot, env: { GIT_DIR: scope.gitDir } });

    const ensureScope = async (scope: Scope): Promise<void> => {
        if (await pathExists(scope.gitDir)) {
            return;
        }
        await git(["init", "--bare", "-q", "--initial-branch=main", scope.gitDir], { cwd: historyRoot, env: {} });
        // Root's list is re-derived later from the live repo set; this only ensures the file exists before add -A.
        await writeFile(join(scope.gitDir, "info", "exclude"), `${COMMON_EXCLUDES.join("\n")}\n`);
    };

    // Rewrite the --separate-git-dir pointer file if the agent deleted it ("root" heals the /work repo's).
    const healGitPointer = async (scope: Scope): Promise<void> => {
        if (await pathExists(join(scope.worktree, ".git"))) {
            return;
        }
        const realGitDir = repoGitDir(historyRoot, scope.name);
        if (await pathExists(realGitDir)) {
            await writeFile(join(scope.worktree, ".git"), `gitdir: ${realGitDir}\n`);
        }
    };

    // Moves a deleted repo's git dir to <historyRoot>/trash (not erased, may hold unpushed commits) so nothing
    // re-adopts a same-named dir later. The scope stays listable, diffable and restorable; it is never reaped.
    const reapGitDir = async (entry: string, reason: string): Promise<void> => {
        const trashRoot = join(historyRoot, "trash");
        await mkdir(trashRoot, { recursive: true });
        await rename(join(historyRoot, "gits", entry), join(trashRoot, `${entry}-${Date.now()}`));
        logger.info({ repo: decodeURIComponent(entry), reason }, "history: reaped a deleted repo's git dir");
    };

    // "deleted" means the index names files and none exist on disk; an empty index is "fresh", not deleted. Exits early
    // on the first file found on disk.
    const deletionState = async (gitDir: string, worktree: string): Promise<"live" | "fresh" | "deleted"> => {
        const { stdout } = await git(["ls-files", "-z"], { cwd: worktree, env: { GIT_DIR: gitDir, GIT_WORK_TREE: worktree } });
        const paths = stdout.split("\0").filter((path) => path !== "");
        if (paths.length === 0) {
            return "fresh";
        }
        for (const path of paths) {
            if (await pathExists(join(worktree, path))) {
                return "live";
            }
        }
        return "deleted";
    };

    // Deletion with a pointer still in place waits a grace period before reaping: a big clone can be briefly empty.
    const emptySince = new Map<string, number>();
    const REAP_GRACE_MS = SNAPSHOT_INTERVAL_MS * 1.5;

    // Pre-discovery heal for daemon-created repos (/history/gits/*) whose .git the agent deleted; a worktree that is
    // gone or holds none of its tracked files is a deletion, reaped rather than healed.
    const healGitPointers = async (): Promise<void> => {
        for (const entry of await readdir(join(historyRoot, "gits")).catch(() => [])) {
            const id = decodeURIComponent(entry);
            if (id === "root") {
                continue;
            }
            // Skips non-repo-id entries: other tools can drop state here, and it must not be treated as a deleted repo.
            if (!isValidRepoId(id)) {
                continue;
            }
            const worktree = join(workspace.root, id);
            const gitDir = join(historyRoot, "gits", entry);
            try {
                if (!(await pathExists(worktree))) {
                    emptySince.delete(entry);
                    await reapGitDir(entry, "worktree deleted");
                    continue;
                }
                const hasPointer = await hasGitEntry(worktree);
                if (!(await looksEmptied(worktree)) || (await deletionState(gitDir, worktree)) !== "deleted") {
                    emptySince.delete(entry);
                    if (!hasPointer) {
                        await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
                    }
                    continue;
                }
                // Deleted: reap now if the pointer is gone; else wait a grace cycle, then reap and drop the pointer
                // too.
                if (!hasPointer) {
                    emptySince.delete(entry);
                    await reapGitDir(entry, "worktree emptied");
                    continue;
                }
                const since = emptySince.get(entry);
                if (since === undefined) {
                    emptySince.set(entry, Date.now());
                } else if (Date.now() - since >= REAP_GRACE_MS) {
                    emptySince.delete(entry);
                    await reapGitDir(entry, "worktree emptied");
                    await rm(join(worktree, ".git"), { force: true });
                }
            } catch (error) {
                logger.warn({ err: error, repo: id }, "history: git-dir heal failed");
            }
        }
    };

    const revParse = async (scope: Scope, rev: string): Promise<string | undefined> => {
        try {
            return (await git(["rev-parse", "-q", "--verify", rev], bare(scope))).stdout.trim();
        } catch {
            return undefined;
        }
    };

    // One snapshot commit for a scope; undefined when its tree is unchanged.
    const snapshotScope = async (scope: Scope, id: string, trigger: SnapshotTrigger, label: string | undefined): Promise<string | undefined> => {
        await ensureScope(scope);
        await healGitPointer(scope);
        const run = { cwd: scope.worktree, env: scopeEnv(scope) };
        try {
            await git(["-c", "advice.addEmbeddedRepo=false", "add", "-A", "--ignore-errors"], run);
        } catch (error) {
            // A commit-less embedded repo aborts `add -A`; keep whatever got staged rather than losing the run.
            logger.warn({ err: error, scope: scope.name }, "history: partial add, snapshotting what staged");
        }
        const tree = (await git(["write-tree"], run)).stdout.trim();
        const prev = await revParse(scope, "refs/snapshots/head");
        if (prev !== undefined && (await revParse(scope, `${prev}^{tree}`)) === tree) {
            return undefined;
        }
        const commit = (
            await git(
                [
                    "-c",
                    `user.name=${AGENT_GIT_AUTHOR.name}`,
                    "-c",
                    `user.email=${AGENT_GIT_AUTHOR.email}`,
                    "commit-tree",
                    tree,
                    ...(prev !== undefined ? ["-p", prev] : []),
                    "-m",
                    `snapshot ${id} ${trigger}`,
                    // The label rides in the commit body, the subject keeps its fixed 3-word grammar.
                    ...(label !== undefined ? ["-m", label] : []),
                ],
                run,
            )
        ).stdout.trim();
        await git(["update-ref", "refs/snapshots/head", commit], run);
        // Plumbing never auto-gcs; without this, loose objects pile up forever.
        await git(["gc", "--auto", "-q"], bare(scope));
        return commit;
    };

    // Every scope that ever recorded history, deleted repos stay listable, diffable, and restorable.
    const knownScopes = async (): Promise<Scope[]> => {
        const entries = await readdir(scopesRoot).catch(() => []);
        return entries.filter((name) => name.endsWith(".git")).map((name) => scopeOf(decodeURIComponent(name.slice(0, -".git".length))));
    };

    const scopeLog = async (scope: Scope): Promise<ScopeCommit[]> => {
        let stdout: string;
        try {
            // -z separates records with NUL; the label (%b) can contain newlines that would break a plain split.
            stdout = (await git(["log", "-z", "-n", "500", "--format=%H%x1f%ct%x1f%s%x1f%b", "refs/snapshots/head"], bare(scope))).stdout;
        } catch {
            return [];
        }
        const commits: ScopeCommit[] = [];
        for (const record of stdout.split("\0")) {
            const [sha, seconds, subject, body] = record.split("\x1f");
            const [word, id, trigger] = (subject ?? "").split(" ");
            const parsed = SnapshotTriggerSchema.safeParse(trigger);
            if (sha === undefined || sha === "" || seconds === undefined || word !== "snapshot" || id === undefined || !parsed.success) {
                continue;
            }
            const label = body?.trim();
            commits.push({
                sha,
                at: Number(seconds) * 1000,
                id,
                trigger: parsed.data,
                ...(label !== undefined && label !== "" ? { label } : {}),
            });
        }
        return commits;
    };

    interface SnapshotGroup extends Snapshot {
        // scope name → that scope's commit in this snapshot.
        readonly commits: Map<string, string>;
    }

    interface HistoryIndex {
        // Every snapshot group, newest first, hidden interval captures included (restore/stateAt need them).
        readonly groups: SnapshotGroup[];
        // scope name → its full snapshot log, newest first, backs stateAt without re-running `git log`.
        readonly logs: Map<string, ScopeCommit[]>;
    }

    // Caches historyIndex(); invalidated only when a snapshot records a change, or a restore runs.
    let indexCache: HistoryIndex | undefined;

    const historyIndex = async (): Promise<HistoryIndex> => {
        if (indexCache !== undefined) {
            return indexCache;
        }
        const logs = new Map<string, ScopeCommit[]>();
        const byId = new Map<string, { id: string; at: number; trigger: SnapshotTrigger; label?: string; commits: Map<string, string> }>();
        for (const scope of await knownScopes()) {
            const log = await scopeLog(scope);
            logs.set(scope.name, log);
            for (const commit of log) {
                const group = byId.get(commit.id) ?? {
                    id: commit.id,
                    at: commit.at,
                    trigger: commit.trigger,
                    ...(commit.label !== undefined ? { label: commit.label } : {}),
                    commits: new Map<string, string>(),
                };
                group.at = Math.max(group.at, commit.at);
                group.commits.set(scope.name, commit.sha);
                byId.set(commit.id, group);
            }
        }
        indexCache = { groups: [...byId.values()].toSorted((a, b) => b.at - a.at), logs };
        return indexCache;
    };

    // The checkpoint timeline, what list/diff/restore expose; interval captures never surface here.
    const visibleGroups = async (): Promise<SnapshotGroup[]> => (await historyIndex()).groups.filter((group) => VISIBLE_TRIGGERS.has(group.trigger));

    const findGroup = async (id: string): Promise<SnapshotGroup | undefined> => (await visibleGroups()).find((group) => group.id === id);

    // The checkpoint a visible group is diffed against, undefined for the oldest (⇒ the empty tree).
    const previousVisible = async (group: SnapshotGroup): Promise<SnapshotGroup | undefined> => {
        const visible = await visibleGroups();
        const position = visible.findIndex((candidate) => candidate.id === group.id);
        return visible[position + 1];
    };

    // A scope's commit at-or-before a group's moment: its own commit there, else the most recent earlier one. undefined
    // means the scope didn't exist yet.
    const stateAt = async (scope: Scope, group: SnapshotGroup): Promise<string | undefined> =>
        group.commits.get(scope.name) ?? ((await historyIndex()).logs.get(scope.name) ?? []).find((commit) => commit.at <= group.at)?.sha;

    const STATUS_BY_LETTER: Record<string, SnapshotChange["status"]> = { A: "added", M: "modified", D: "deleted", T: "type-changed" };

    const scopeDiff = async (scope: Scope, from: string, to: string): Promise<SnapshotChange[]> => {
        const { stdout } = await git(["diff-tree", "-r", "--name-status", "-z", from, to], bare(scope));
        const parts = stdout.split("\0");
        const changes: SnapshotChange[] = [];
        for (let index = 0; index + 1 < parts.length; index += 2) {
            const status = STATUS_BY_LETTER[parts[index] ?? ""];
            const path = parts[index + 1];
            if (status !== undefined && path !== undefined && path !== "") {
                changes.push({ scope: scope.name, path, status });
            }
        }
        return changes;
    };

    // A file's content at <commit>:<path>; undefined if absent, size-only if over the ship cap, flagged if binary.
    const fileAt = async (scope: Scope, sha: string, path: string): Promise<CheckpointSide | undefined> => {
        const spec = `${sha}:${path}`;
        let bytes: number;
        try {
            bytes = Number((await git(["cat-file", "-s", spec], bare(scope))).stdout.trim());
        } catch {
            return undefined;
        }
        if (bytes > MAX_FILE_DIFF_BYTES) {
            return { bytes };
        }
        const content = (await git(["cat-file", "-p", spec], bare(scope))).stdout;
        return content.includes("\0") ? { binary: true, bytes } : { content, bytes };
    };

    // Serialize snapshot + restore, they share the per-scope snapshot.index files.
    let chain: Promise<unknown> = Promise.resolve();
    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const next = chain.then(task, task);
        chain = next.catch(() => undefined);
        return next;
    };

    const snapshotAll = async (trigger: SnapshotTrigger, label?: string): Promise<string | undefined> => {
        await mkdir(scopesRoot, { recursive: true });
        // Heal, discover, sync excludes, then snapshot, so excludes are never staler than this cycle's repo set.
        await healGitPointers();
        const rootScope = scopeOf("root");
        await ensureScope(rootScope);
        const repoIds = await discoverRepos(workspace.root);
        await syncRootExcludes(historyRoot, repoIds);
        const id = randomUUID();
        const cleanLabel = label !== undefined ? sanitizeLabel(label) : undefined;
        let changed = false;
        for (const scope of [rootScope, ...repoIds.map(scopeOf)]) {
            try {
                if ((await snapshotScope(scope, id, trigger, cleanLabel)) !== undefined) {
                    changed = true;
                }
            } catch (error) {
                logger.warn({ err: error, scope: scope.name }, "history: scope snapshot failed");
            }
        }
        if (changed) {
            indexCache = undefined;
        }
        return changed ? id : undefined;
    };

    // Matches the worktree to the scope's tree at `sha`: clean removes files added since (ignored paths survive),
    // checkout-index -u writes it back and refreshes stat info.
    const restoreScope = async (scope: Scope, sha: string): Promise<void> => {
        await mkdir(scope.worktree, { recursive: true });
        await healGitPointer(scope);
        const run = { cwd: scope.worktree, env: scopeEnv(scope) };
        await git(["read-tree", sha], run);
        await git(["clean", "-q", "-f", "-d"], run);
        await git(["checkout-index", "-q", "-f", "-a", "-u"], run);
    };

    const restoreAll = async (group: SnapshotGroup): Promise<void> => {
        await snapshotAll("pre-restore");
        const scopes = await knownScopes();
        // Restored repos must be excluded before the root scope's clean runs, or it wipes the just-restored worktrees.
        await syncRootExcludes(
            historyRoot,
            scopes.filter((scope) => scope.name !== "root").map((scope) => scope.name),
        );
        // Restores every known scope, not only those the snapshot lists as changed; one created later is left in place.
        for (const scope of scopes) {
            const sha = await stateAt(scope, group);
            if (sha === undefined) {
                continue;
            }
            try {
                await restoreScope(scope, sha);
            } catch (error) {
                logger.warn({ err: error, scope: scope.name }, "history: scope restore failed");
            }
        }
        // Record the restore point; history is append-only, never rewound.
        await snapshotAll("restore");
        indexCache = undefined;
    };

    let timer: NodeJS.Timeout | undefined;
    let userWriteTimer: NodeJS.Timeout | undefined;
    const snapshot = (trigger: SnapshotTrigger, label?: string): Promise<string | undefined> => serialize(() => snapshotAll(trigger, label));

    return {
        start: () => {
            if (timer !== undefined) {
                return;
            }
            const tick = (): void =>
                void snapshot("interval").catch((error: unknown) => logger.warn({ err: error }, "history: interval snapshot failed"));
            tick();
            timer = setInterval(tick, SNAPSHOT_INTERVAL_MS);
            timer.unref();
        },
        stop: () => {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
            if (userWriteTimer !== undefined) {
                clearTimeout(userWriteTimer);
                userWriteTimer = undefined;
            }
        },
        snapshot,
        notifyUserWrite: () => {
            if (userWriteTimer !== undefined) {
                clearTimeout(userWriteTimer);
            }
            userWriteTimer = setTimeout(() => {
                userWriteTimer = undefined;
                void snapshot("user").catch((error: unknown) => logger.warn({ err: error }, "history: user snapshot failed"));
            }, USER_WRITE_DEBOUNCE_MS);
            userWriteTimer.unref();
        },
        list: async () =>
            (await visibleGroups()).map(({ id, at, trigger, label }) => (label !== undefined ? { id, at, trigger, label } : { id, at, trigger })),
        // A checkpoint's diff spans everything since the previous visible checkpoint; captures hidden in between are
        // folded in by design.
        diff: async (id) => {
            const group = await findGroup(id);
            if (group === undefined) {
                return undefined;
            }
            const base = await previousVisible(group);
            const changes: SnapshotChange[] = [];
            for (const scope of await knownScopes()) {
                const to = await stateAt(scope, group);
                if (to === undefined) {
                    continue;
                }
                const from = base !== undefined ? await stateAt(scope, base) : undefined;
                if (from === to) {
                    continue;
                }
                changes.push(...(await scopeDiff(scope, from ?? EMPTY_TREE, to)));
            }
            return changes;
        },
        fileDiff: async (id, scopeName, path) => {
            const group = await findGroup(id);
            if (group === undefined) {
                return undefined;
            }
            const scope = scopeOf(scopeName);
            const to = await stateAt(scope, group);
            if (to === undefined) {
                return undefined;
            }
            const base = await previousVisible(group);
            const from = base !== undefined ? await stateAt(scope, base) : undefined;
            const before = from !== undefined ? await fileAt(scope, from, path) : undefined;
            const after = await fileAt(scope, to, path);
            const flagged = before?.binary === true || after?.binary === true;
            // Over the cap: patches the same commit pair against the previous visible checkpoint, not the raw parent.
            if (overCap(before) || overCap(after)) {
                const { binary, partial } = await partialDiff(
                    async (args) => (await git(args, bare(scope))).stdout,
                    [from ?? EMPTY_TREE, to, "--", path],
                    { before: before?.bytes, after: after?.bytes },
                );
                return { ...(binary || flagged ? { binary: true } : {}), partial };
            }
            return {
                ...(before?.content !== undefined ? { before: before.content } : {}),
                ...(after?.content !== undefined ? { after: after.content } : {}),
                ...(flagged ? { binary: true } : {}),
            };
        },
        // Same two commits fileDiff pairs, as rev-specs instead of read text, so the raw route serves exactly the side
        // the checkpoint's diff showed.
        fileBlob: async (id, scopeName, path, side) => {
            const group = await findGroup(id);
            if (group === undefined) {
                return undefined;
            }
            const scope = scopeOf(scopeName);
            if (side === "after") {
                const to = await stateAt(scope, group);
                return to === undefined ? undefined : { dir: scope.gitDir, spec: `${to}:${path}` };
            }
            const base = await previousVisible(group);
            const from = base !== undefined ? await stateAt(scope, base) : undefined;
            return from === undefined ? undefined : { dir: scope.gitDir, spec: `${from}:${path}` };
        },
        restore: async (id) => {
            const group = await findGroup(id);
            if (group === undefined) {
                return false;
            }
            await serialize(() => restoreAll(group));
            return true;
        },
    };
};

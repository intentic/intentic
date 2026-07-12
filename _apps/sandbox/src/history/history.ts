import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type FileDiff, type Snapshot, type SnapshotChange, SnapshotTriggerSchema, type SnapshotTrigger } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { isValidRepoName } from "../workspace/repos.js";
import { REPO_ROLES, type WorkspacePaths } from "../workspace/workspace.js";

// Daemon-owned workspace history: every scope (the /work root plus each repo under /work/repositories) gets a
// bare git dir under <historyRoot>/scopes, and snapshots are taken with a private index (add -A → write-tree →
// commit-tree → update-ref refs/snapshots/head). The agent's own repos are never touched — no commits land on
// its branches, no HEAD/index moves — and the history lives outside /work, so workspace accidents (rm -rf,
// git clean, a deleted .git) can't destroy it. One shared uuid in every scope's commit message groups the
// per-scope commits into a single logical "workspace snapshot". A restore rewrites worktree files only — the
// real repos' HEADs stay put, so the restored-vs-HEAD delta surfaces in the Changes review afterwards
// (intended: restore is the safety net, commit/discard is the review).

const exec = promisify(execFile);

const SNAPSHOT_INTERVAL_MS = 60_000;
// Trailing debounce for user-write pings — long enough to coalesce a sequential multi-file drop into one snapshot.
const USER_WRITE_DEBOUNCE_MS = 2_000;
// git's well-known empty tree — the diff base for a scope's first snapshot (and an unborn HEAD in git/changes.ts).
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// File contents above this are flagged `truncated` instead of shipped to the diff UI (shared with the git
// routes' working-tree file diff so both diff surfaces guard identically).
export const MAX_FILE_DIFF_BYTES = 512 * 1024;

// Runs git with the scope's detached-worktree env; injectable so the command sequences are unit-testable
// without a real repo (mirrors git.ts's GitRunner seam, which can't carry env/cwd separately).
export type HistoryGitRunner = (
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;
const defaultRunner: HistoryGitRunner = (args, options) =>
    exec("git", [...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, maxBuffer: 8 * 1024 * 1024 });

// The protected real git dir for a daemon-created nested repo: scaffold + addRepo pass this to
// --separate-git-dir, so the in-worktree .git is a pointer file the daemon rewrites if the agent deletes it.
export const repoGitDir = (historyRoot: string, name: string): string => join(historyRoot, "gits", name);

// Junk + secret patterns every scope excludes (the worktree's own .gitignore files apply on top). Lives in
// $GIT_DIR/info/exclude — outside /work — so the agent can't edit the rules. A self-contained list (the secret
// files + workspace-ignore's IGNORED_DIRS): history snapshots keep excluding secrets even though the file tree
// now lists them.
const COMMON_EXCLUDES = [
    ".env*",
    "!.env.example",
    ".secrets.json",
    "claude.json",
    "capabilities.json",
    "node_modules/",
    ".tmp/",
    "dist/",
    ".cache/",
    ".turbo/",
    ".next/",
    ".angular/",
    ".pnpm-store/",
    ".yarn/",
    ".venv/",
    "venv/",
    "__pycache__/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    ".gradle/",
];
// The root scope additionally skips /repositories/ (each repo is its own scope — also avoids git's
// embedded-repo gitlink handling) and /.intentic/ (daemon-internal manifests + credentials). The real /work
// repo (git/root-repo.ts) shares this list so history and review agree on what's versionable.
export const ROOT_EXCLUDES = ["/repositories/", "/.intentic/", ...COMMON_EXCLUDES];

export interface WorkspaceHistory {
    readonly start: () => void;
    readonly stop: () => void;
    // Returns the snapshot id, or undefined when nothing changed anywhere since the last snapshot.
    readonly snapshot: (trigger: SnapshotTrigger) => Promise<string | undefined>;
    // Ping from a user-initiated write route (upload / mkdir / delete / move / copy / clone). Trailing-debounced
    // into one snapshot("user") per user gesture, so a 100-file drop is one timeline entry, not a hundred.
    readonly notifyUserWrite: () => void;
    readonly list: () => Promise<Snapshot[]>;
    // undefined ⇒ unknown snapshot id (routes map it to NOT_FOUND). What the snapshot changed vs its parent.
    readonly diff: (id: string) => Promise<SnapshotChange[] | undefined>;
    readonly fileDiff: (id: string, scope: string, path: string) => Promise<FileDiff | undefined>;
    readonly restore: (id: string) => Promise<boolean>;
}

interface Scope {
    // "root" or "repositories/<name>" — the wire-visible scope name.
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
}

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

export const createWorkspaceHistory = (
    options: { readonly workspace: WorkspacePaths; readonly historyRoot: string; readonly logger: Logger },
    git: HistoryGitRunner = defaultRunner,
): WorkspaceHistory => {
    const { workspace, historyRoot, logger } = options;
    const scopesRoot = join(historyRoot, "scopes");

    const scopeOf = (name: string): Scope => {
        if (name === "root") {
            return { name, gitDir: join(scopesRoot, "root.git"), worktree: workspace.root };
        }
        const repo = name.slice("repositories/".length);
        return { name, gitDir: join(scopesRoot, `repositories__${repo}.git`), worktree: join(workspace.repositories, repo) };
    };

    // The env every worktree-touching command runs with. The private index keeps the agent's repos untouched
    // and makes repeat scans stat-only; cwd must be the worktree (git treats cwd as worktree top otherwise).
    const scopeEnv = (scope: Scope): Record<string, string> => ({
        GIT_DIR: scope.gitDir,
        GIT_WORK_TREE: scope.worktree,
        GIT_INDEX_FILE: join(scope.gitDir, "snapshot.index"),
    });
    // Tree-to-tree ops (log/diff-tree/cat-file) need no worktree — they must work after a repo is deleted.
    const bare = (scope: Scope): { cwd: string; env: Record<string, string> } => ({ cwd: historyRoot, env: { GIT_DIR: scope.gitDir } });

    const ensureScope = async (scope: Scope): Promise<void> => {
        if (await exists(scope.gitDir)) {
            return;
        }
        await git(["init", "--bare", "-q", scope.gitDir], { cwd: historyRoot, env: {} });
        const excludes = scope.name === "root" ? ROOT_EXCLUDES : COMMON_EXCLUDES;
        await writeFile(join(scope.gitDir, "info", "exclude"), `${excludes.join("\n")}\n`);
    };

    // Rewrite the --separate-git-dir pointer file if the agent deleted it ("root" heals the /work repo's).
    const healGitPointer = async (scope: Scope): Promise<void> => {
        if (await exists(join(scope.worktree, ".git"))) {
            return;
        }
        const realGitDir = repoGitDir(historyRoot, scope.name === "root" ? "root" : scope.name.slice("repositories/".length));
        if (await exists(realGitDir)) {
            await writeFile(join(scope.worktree, ".git"), `gitdir: ${realGitDir}\n`);
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
    const snapshotScope = async (scope: Scope, id: string, trigger: SnapshotTrigger): Promise<string | undefined> => {
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
                ],
                run,
            )
        ).stdout.trim();
        await git(["update-ref", "refs/snapshots/head", commit], run);
        // Plumbing never auto-gcs; without this, loose objects pile up forever.
        await git(["gc", "--auto", "-q"], bare(scope));
        return commit;
    };

    // Live scopes to snapshot: the root, plus every directory under /work/repositories (with or without a .git
    // — a deleted .git must not hide a repo from history).
    const liveScopes = async (): Promise<Scope[]> => {
        const scopes = [scopeOf("root")];
        const entries = await readdir(workspace.repositories, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isDirectory() && (isValidRepoName(entry.name) || (REPO_ROLES as readonly string[]).includes(entry.name))) {
                scopes.push(scopeOf(`repositories/${entry.name}`));
            }
        }
        return scopes;
    };

    // Every scope that ever recorded history — deleted repos stay listable, diffable, and restorable.
    const knownScopes = async (): Promise<Scope[]> => {
        const entries = await readdir(scopesRoot).catch(() => []);
        return entries
            .filter((name) => name.endsWith(".git"))
            .map((name) => {
                const stem = name.slice(0, -".git".length);
                return scopeOf(stem === "root" ? "root" : `repositories/${stem.slice("repositories__".length)}`);
            });
    };

    const scopeLog = async (scope: Scope): Promise<ScopeCommit[]> => {
        let stdout: string;
        try {
            stdout = (await git(["log", "-n", "500", "--format=%H%x1f%ct%x1f%s", "refs/snapshots/head"], bare(scope))).stdout;
        } catch {
            return [];
        }
        const commits: ScopeCommit[] = [];
        for (const line of stdout.split("\n")) {
            const [sha, seconds, subject] = line.split("\x1f");
            const [word, id, trigger] = (subject ?? "").split(" ");
            const parsed = SnapshotTriggerSchema.safeParse(trigger);
            if (sha === undefined || sha === "" || seconds === undefined || word !== "snapshot" || id === undefined || !parsed.success) {
                continue;
            }
            commits.push({ sha, at: Number(seconds) * 1000, id, trigger: parsed.data });
        }
        return commits;
    };

    interface SnapshotGroup extends Snapshot {
        // scope name → that scope's commit in this snapshot.
        readonly commits: Map<string, string>;
    }

    // groups() runs one `git log` per known scope; list/diff/fileDiff all funnel through it, so a file-diff
    // click would otherwise re-scan every scope. Cache the result and invalidate only when history changes
    // (a snapshot that recorded something, or a restore). Both mutators run under the serialize chain.
    let groupsCache: SnapshotGroup[] | undefined;

    const groups = async (): Promise<SnapshotGroup[]> => {
        if (groupsCache !== undefined) {
            return groupsCache;
        }
        const byId = new Map<string, { at: number; trigger: SnapshotTrigger; commits: Map<string, string> }>();
        for (const scope of await knownScopes()) {
            for (const commit of await scopeLog(scope)) {
                const group = byId.get(commit.id) ?? { at: commit.at, trigger: commit.trigger, commits: new Map<string, string>() };
                group.at = Math.max(group.at, commit.at);
                group.commits.set(scope.name, commit.sha);
                byId.set(commit.id, group);
            }
        }
        groupsCache = [...byId.entries()]
            .map(([id, group]) => ({
                id,
                at: group.at,
                trigger: group.trigger,
                scopes: [...group.commits.keys()].toSorted(),
                commits: group.commits,
            }))
            .toSorted((a, b) => b.at - a.at);
        return groupsCache;
    };

    const findGroup = async (id: string): Promise<SnapshotGroup | undefined> => (await groups()).find((group) => group.id === id);

    // Parent of a scope's snapshot commit — the empty tree for the first one.
    const parentOf = async (scope: Scope, sha: string): Promise<string> => (await revParse(scope, `${sha}^`)) ?? EMPTY_TREE;

    // A scope's commit at-or-before a snapshot group's moment: its own commit in that group, else the most recent
    // earlier one (a scope only appears in the groups where it changed). undefined ⇒ the scope didn't exist yet.
    const stateAt = async (scope: Scope, group: SnapshotGroup): Promise<string | undefined> =>
        group.commits.get(scope.name) ?? (await scopeLog(scope)).find((commit) => commit.at <= group.at)?.sha;

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

    // A file's content at <commit>:<path>; undefined when absent, flagged instead of shipped when huge/binary.
    const fileAt = async (
        scope: Scope,
        sha: string,
        path: string,
    ): Promise<{ content?: string; binary?: boolean; truncated?: boolean } | undefined> => {
        const spec = `${sha}:${path}`;
        let size: number;
        try {
            size = Number((await git(["cat-file", "-s", spec], bare(scope))).stdout.trim());
        } catch {
            return undefined;
        }
        if (size > MAX_FILE_DIFF_BYTES) {
            return { truncated: true };
        }
        const content = (await git(["cat-file", "-p", spec], bare(scope))).stdout;
        return content.includes("\0") ? { binary: true } : { content };
    };

    // Serialize snapshot + restore — they share the per-scope snapshot.index files.
    let chain: Promise<unknown> = Promise.resolve();
    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const next = chain.then(task, task);
        chain = next.catch(() => undefined);
        return next;
    };

    const snapshotAll = async (trigger: SnapshotTrigger): Promise<string | undefined> => {
        await mkdir(scopesRoot, { recursive: true });
        const id = randomUUID();
        let changed = false;
        for (const scope of await liveScopes()) {
            try {
                if ((await snapshotScope(scope, id, trigger)) !== undefined) {
                    changed = true;
                }
            } catch (error) {
                logger.warn({ err: error, scope: scope.name }, "history: scope snapshot failed");
            }
        }
        if (changed) {
            groupsCache = undefined;
        }
        return changed ? id : undefined;
    };

    // Make the worktree match the scope's tree at `sha`: files created since are cleaned (ignored files —
    // secrets, node_modules — survive; clean judges "untracked" against the just-read index), then the
    // snapshot's files are written out. -u refreshes stat info so the next scan stays cheap.
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
        // Restore EVERY known scope to its state at the group's moment — a snapshot only lists the scopes that
        // changed in it, but "bring the workspace back" means all of them. A scope with no commit at-or-before
        // that moment (created later) is left in place.
        for (const scope of await knownScopes()) {
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
        groupsCache = undefined;
    };

    let timer: NodeJS.Timeout | undefined;
    let userWriteTimer: NodeJS.Timeout | undefined;
    const snapshot = (trigger: SnapshotTrigger): Promise<string | undefined> => serialize(() => snapshotAll(trigger));

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
        list: async () => (await groups()).map(({ id, at, trigger, scopes }) => ({ id, at, trigger, scopes })),
        diff: async (id) => {
            const group = await findGroup(id);
            if (group === undefined) {
                return undefined;
            }
            const changes: SnapshotChange[] = [];
            for (const [name, sha] of group.commits) {
                const scope = scopeOf(name);
                changes.push(...(await scopeDiff(scope, await parentOf(scope, sha), sha)));
            }
            return changes;
        },
        fileDiff: async (id, scopeName, path) => {
            const group = await findGroup(id);
            if (group === undefined) {
                return undefined;
            }
            const scope = scopeOf(scopeName);
            const sha = group.commits.get(scopeName);
            if (sha === undefined) {
                return undefined;
            }
            const before = await fileAt(scope, await parentOf(scope, sha), path);
            const after = await fileAt(scope, sha, path);
            return {
                ...(before?.content !== undefined ? { before: before.content } : {}),
                ...(after?.content !== undefined ? { after: after.content } : {}),
                ...(before?.binary === true || after?.binary === true ? { binary: true } : {}),
                ...(before?.truncated === true || after?.truncated === true ? { truncated: true } : {}),
            };
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

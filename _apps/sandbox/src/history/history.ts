import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type FileDiff, type Snapshot, type SnapshotChange, SnapshotTriggerSchema, type SnapshotTrigger } from "@intentic/sandbox-contract";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { discoverRepos, hasGitEntry } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

// Daemon-owned workspace history: every scope (the /work root plus each discovered repo under it) gets a
// bare git dir under <historyRoot>/scopes, and snapshots are taken with a private index (add -A → write-tree →
// commit-tree → update-ref refs/snapshots/head). The agent's own repos are never touched — no commits land on
// its branches, no HEAD/index moves — and the history lives outside /work, so workspace accidents (rm -rf,
// git clean, a deleted .git) can't destroy it. One shared uuid in every scope's commit message groups the
// per-scope commits into a single logical "workspace snapshot". A restore rewrites worktree files only — the
// real repos' HEADs stay put, so the restored-vs-HEAD delta surfaces in the Changes review afterwards
// (intended: restore is the safety net, commit/discard is the review).
//
// The timeline users see is CHECKPOINTS, not raw captures: only turn / user / pre-restore / restore snapshots
// are listed (turns labeled with the turn's prompt, carried in the commit body), while "interval" captures stay
// a hidden safety net — the only cover for terminal-made edits, which never ping notifyUserWrite. A visible
// checkpoint's diff therefore compares against the PREVIOUS VISIBLE checkpoint, not the raw git parent, so
// hidden captures dissolve into the next checkpoint instead of fragmenting it.

const exec = promisify(execFile);

const SNAPSHOT_INTERVAL_MS = 60_000;
// Trailing debounce for user-write pings — long enough to coalesce a sequential multi-file drop into one snapshot.
const USER_WRITE_DEBOUNCE_MS = 2_000;
// The triggers that surface as timeline checkpoints; "interval" captures are hidden safety sweeps.
const VISIBLE_TRIGGERS: ReadonlySet<SnapshotTrigger> = new Set(["turn", "user", "pre-restore", "restore"]);
const MAX_LABEL_LENGTH = 160;
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

// The protected real git dir for a daemon-created repo: scaffold + addRepo pass this to --separate-git-dir,
// so the in-worktree .git is a pointer file the daemon rewrites if the agent deletes it. The dir name is the
// URI-encoded repo id (single-segment ids encode to themselves) so nested ids stay one filesystem entry.
export const repoGitDir = (historyRoot: string, name: string): string => join(historyRoot, "gits", encodeURIComponent(name));

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
    "extension-settings.json",
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
// The root scope additionally skips every discovered repo dir (each repo is its own scope — also avoids git's
// embedded-repo gitlink handling) and /.intentic/ (daemon-internal manifests + credentials). Repos can appear
// anywhere under /work, so the list is DERIVED from the live repo set, not static.
export const rootExcludes = (repoIds: readonly string[]): string[] => [...repoIds.map((id) => `/${id}/`), "/.intentic/", ...COMMON_EXCLUDES];

// Converge the root exclude list onto both consumers — the real /work repo's git dir (git/root-repo.ts; its
// info/ is shared with every agent worktree) and the history root scope's — so history and the Changes review
// agree on what's versionable. Compare-then-write keeps the every-snapshot call stat-cheap; a target whose git
// dir doesn't exist yet (fresh boot) is skipped and converges when it's created.
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
    // Returns the snapshot id, or undefined when nothing changed anywhere since the last snapshot. The label
    // (e.g. a turn's prompt) becomes the checkpoint's timeline title.
    readonly snapshot: (trigger: SnapshotTrigger, label?: string) => Promise<string | undefined>;
    // Ping from a user-initiated write route (upload / mkdir / delete / move / copy / clone). Trailing-debounced
    // into one snapshot("user") per user gesture, so a 100-file drop is one timeline entry, not a hundred.
    readonly notifyUserWrite: () => void;
    readonly list: () => Promise<Snapshot[]>;
    // undefined ⇒ unknown snapshot id (routes map it to NOT_FOUND). What the snapshot changed vs its parent.
    readonly diff: (id: string) => Promise<SnapshotChange[] | undefined>;
    readonly fileDiff: (id: string, scope: string, path: string) => Promise<FileDiff | undefined>;
    // Where one side of that same diff's BYTES live — the bare scope repo and the rev-spec inside it — for the
    // raw route that serves what fileDiff refuses to ship (an image, which the browser renders from the bytes
    // and fileDiff can only flag as binary). Reading them is the route's job, so every diff source funnels
    // through one size guard and one 404. undefined ⇒ unknown checkpoint/scope, or a side this file never had.
    readonly fileBlob: (id: string, scope: string, path: string, side: "before" | "after") => Promise<{ dir: string; spec: string } | undefined>;
    readonly restore: (id: string) => Promise<boolean>;
}

interface Scope {
    // "root" or a repo id (the root-relative repo dir, e.g. "intent" or "clients/foo") — the wire-visible
    // scope name.
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

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// Labels live in commit bodies and come from free-form prompts — collapse to one bounded line so `git log`
// parsing and the timeline row stay tame.
const sanitizeLabel = (label: string): string | undefined => {
    const clean = label
        .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, MAX_LABEL_LENGTH);
    return clean === "" ? undefined : clean;
};

// The env every worktree-touching command runs with. The private index keeps the agent's repos untouched
// and makes repeat scans stat-only; cwd must be the worktree (git treats cwd as worktree top otherwise).
const scopeEnv = (scope: Scope): Record<string, string> => ({
    GIT_DIR: scope.gitDir,
    GIT_WORK_TREE: scope.worktree,
    GIT_INDEX_FILE: join(scope.gitDir, "snapshot.index"),
});

export const createWorkspaceHistory = (
    options: { readonly workspace: WorkspacePaths; readonly historyRoot: string; readonly logger: Logger },
    git: HistoryGitRunner = defaultRunner,
): WorkspaceHistory => {
    const { workspace, historyRoot, logger } = options;
    const scopesRoot = join(historyRoot, "scopes");

    // The scope's git dir name is the URI-encoded scope name (slashes in nested repo ids become %2F, so every
    // scope stays one filesystem entry and decodes losslessly in knownScopes).
    const scopeOf = (name: string): Scope => ({
        name,
        gitDir: join(scopesRoot, `${encodeURIComponent(name)}.git`),
        worktree: name === "root" ? workspace.root : join(workspace.root, name),
    });

    // Tree-to-tree ops (log/diff-tree/cat-file) need no worktree — they must work after a repo is deleted.
    const bare = (scope: Scope): { cwd: string; env: Record<string, string> } => ({ cwd: historyRoot, env: { GIT_DIR: scope.gitDir } });

    const ensureScope = async (scope: Scope): Promise<void> => {
        if (await exists(scope.gitDir)) {
            return;
        }
        await git(["init", "--bare", "-q", "--initial-branch=main", scope.gitDir], { cwd: historyRoot, env: {} });
        // The root scope's list is immediately re-derived from the live repo set (syncRootExcludes in
        // snapshotAll) — this seed just guarantees the file exists before the first add -A.
        await writeFile(join(scope.gitDir, "info", "exclude"), `${COMMON_EXCLUDES.join("\n")}\n`);
    };

    // Rewrite the --separate-git-dir pointer file if the agent deleted it ("root" heals the /work repo's).
    const healGitPointer = async (scope: Scope): Promise<void> => {
        if (await exists(join(scope.worktree, ".git"))) {
            return;
        }
        const realGitDir = repoGitDir(historyRoot, scope.name);
        if (await exists(realGitDir)) {
            await writeFile(join(scope.worktree, ".git"), `gitdir: ${realGitDir}\n`);
        }
    };

    // A repo the user deleted must STAY deleted: its parked git dir moves to <historyRoot>/trash (kept, not
    // erased — it may hold unpushed commits) so nothing re-adopts a future dir of the same name and heal stops
    // resurrecting it. Its scope repo is deliberately NOT reaped — deleted repos stay on the Checkpoints
    // timeline, diffable and restorable, and a restore recreates the worktree (restoreScope) which a later
    // snapshot cycle then re-discovers as an ordinary in-tree repo.
    const reapGitDir = async (entry: string, reason: string): Promise<void> => {
        const trashRoot = join(historyRoot, "trash");
        await mkdir(trashRoot, { recursive: true });
        await rename(join(historyRoot, "gits", entry), join(trashRoot, `${entry}-${Date.now()}`));
        logger.info({ repo: decodeURIComponent(entry), reason }, "history: reaped a deleted repo's git dir");
    };

    // Is the worktree down to deletion remnants? A deletion (local rm carried in by desktop sync, an agent's
    // rm -rf) removes every tracked file but CANNOT remove what sync ignores — node_modules, dist, the .git
    // pointer — so "the directory still exists" proves nothing. This readdir is the cheap gate in front of the
    // real check below: a live repo virtually always has a plain file or dir at its root, so the healthy case
    // costs one readdir and no git spawn.
    const looksEmptied = async (worktree: string): Promise<boolean> => {
        const entries = await readdir(worktree, { withFileTypes: true }).catch(() => []);
        return entries.every((entry) => entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name));
    };

    // The definitive read: "deleted" ⇔ the index names files and NONE of them is on disk. An empty index is a
    // fresh repo, not a deletion. Early exit on the first file found keeps a merely dotfile-rooted repo cheap.
    const deletionState = async (gitDir: string, worktree: string): Promise<"live" | "fresh" | "deleted"> => {
        const { stdout } = await git(["ls-files", "-z"], { cwd: worktree, env: { GIT_DIR: gitDir, GIT_WORK_TREE: worktree } });
        const paths = stdout.split("\0").filter((path) => path !== "");
        if (paths.length === 0) {
            return "fresh";
        }
        for (const path of paths) {
            if (await exists(join(worktree, path))) {
                return "live";
            }
        }
        return "deleted";
    };

    // A deletion seen while the pointer is still in place waits out one full snapshot interval before it reaps
    // (git-dir entry → when it was first seen empty): a huge clone's checkout can momentarily be file-less, and
    // real files appearing by the next cycle clears the suspicion. A deliberate deletion only gets more deleted.
    const emptySince = new Map<string, number>();
    const REAP_GRACE_MS = SNAPSHOT_INTERVAL_MS * 1.5;

    // Pre-discovery heal for every DAEMON-created repo (/history/gits/*): a repo whose in-worktree .git the
    // agent deleted would otherwise vanish from .git-based discovery — and with it from history. Repos the
    // AGENT created (in-worktree .git dirs, no /history/gits entry) that lose their .git intentionally stop
    // being repos: their files dissolve into the root scope, which still covers them.
    //
    // Healing is for ACCIDENTS, so it first rules out intent. Rewriting the pointer into a deletion's remnant
    // dir used to resurrect the repo as thousands of phantom deletions, forever — sync could never remove the
    // ignored remnants keeping the dir alive, and every cycle re-adopted them. A worktree that is gone, or
    // holds none of its tracked files, is a deletion: reap the git dir instead of healing it.
    const healGitPointers = async (): Promise<void> => {
        for (const entry of await readdir(join(historyRoot, "gits")).catch(() => [])) {
            const id = decodeURIComponent(entry);
            if (id === "root") {
                continue;
            }
            const worktree = join(workspace.root, id);
            const gitDir = join(historyRoot, "gits", entry);
            try {
                if (!(await exists(worktree))) {
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
                // Deleted. Without a pointer the intent is doubly clear — reap now. With one still in place,
                // hold for a grace cycle, then reap AND drop the pointer so discovery stops finding a repo
                // whose git dir is gone.
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
                    // The label rides in the commit body — the subject keeps its fixed 3-word grammar.
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

    // Every scope that ever recorded history — deleted repos stay listable, diffable, and restorable.
    const knownScopes = async (): Promise<Scope[]> => {
        const entries = await readdir(scopesRoot).catch(() => []);
        return entries.filter((name) => name.endsWith(".git")).map((name) => scopeOf(decodeURIComponent(name.slice(0, -".git".length))));
    };

    const scopeLog = async (scope: Scope): Promise<ScopeCommit[]> => {
        let stdout: string;
        try {
            // -z separates records with NUL — the body (%b) carries the label, which a newline split would shred.
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
        // Every snapshot group, newest first — hidden interval captures included (restore/stateAt need them).
        readonly groups: SnapshotGroup[];
        // scope name → its full snapshot log, newest first — backs stateAt without re-running `git log`.
        readonly logs: Map<string, ScopeCommit[]>;
    }

    // historyIndex() runs one `git log` per known scope; list/diff/fileDiff/restore all funnel through it, so a
    // file-diff click would otherwise re-scan every scope. Cache the result and invalidate only when history
    // changes (a snapshot that recorded something, or a restore). Both mutators run under the serialize chain.
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

    // The checkpoint timeline — what list/diff/restore expose; interval captures never surface here.
    const visibleGroups = async (): Promise<SnapshotGroup[]> => (await historyIndex()).groups.filter((group) => VISIBLE_TRIGGERS.has(group.trigger));

    const findGroup = async (id: string): Promise<SnapshotGroup | undefined> => (await visibleGroups()).find((group) => group.id === id);

    // The checkpoint a visible group is diffed against — undefined for the oldest (⇒ the empty tree).
    const previousVisible = async (group: SnapshotGroup): Promise<SnapshotGroup | undefined> => {
        const visible = await visibleGroups();
        const position = visible.findIndex((candidate) => candidate.id === group.id);
        return visible[position + 1];
    };

    // A scope's commit at-or-before a snapshot group's moment: its own commit in that group, else the most recent
    // earlier one (a scope only appears in the groups where it changed). undefined ⇒ the scope didn't exist yet.
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

    const snapshotAll = async (trigger: SnapshotTrigger, label?: string): Promise<string | undefined> => {
        await mkdir(scopesRoot, { recursive: true });
        // Heal → discover → sync excludes → snapshot, in that order: the heal makes daemon-created repos
        // discoverable again, and the root scope never runs its add -A with excludes staler than this cycle's
        // repo set (a fresh clone's files must not sweep into the root scope).
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
        const scopes = await knownScopes();
        // The repo dirs being restored must be in the root excludes BEFORE the root scope's clean runs: the
        // restore brings back dirs that live discovery (post-deletion) no longer excludes, and without this
        // the root clean would wipe the just-restored nested worktrees. The trailing snapshotAll re-derives
        // the list from live discovery — a restored repo without a .git then dissolves into the root scope.
        await syncRootExcludes(
            historyRoot,
            scopes.filter((scope) => scope.name !== "root").map((scope) => scope.name),
        );
        // Restore EVERY known scope to its state at the group's moment — a snapshot only lists the scopes that
        // changed in it, but "bring the workspace back" means all of them. A scope with no commit at-or-before
        // that moment (created later) is left in place.
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
        // A checkpoint's diff spans everything since the previous visible checkpoint — hidden interval captures
        // in between are the point of the base choice, not an accident.
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
            return {
                ...(before?.content !== undefined ? { before: before.content } : {}),
                ...(after?.content !== undefined ? { after: after.content } : {}),
                ...(before?.binary === true || after?.binary === true ? { binary: true } : {}),
                ...(before?.truncated === true || after?.truncated === true ? { truncated: true } : {}),
            };
        },
        // The same two commits fileDiff pairs, handed over as rev-specs instead of read as text — so the raw
        // route serves exactly the side the checkpoint's diff was showing, never a neighbouring capture's.
        // Bare repos take a plain `-C <gitdir>`, so the spec pairs with the scope's dir like any other source.
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

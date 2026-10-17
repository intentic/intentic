import { access, lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { VERSIONED_STATE_PATHS } from "@intentic/sandbox-contract/state/workspace-state";
import { undefinedIfMissing } from "@intentic/base/errors";
import { IGNORED_DIRS, REFERENCE_DIR } from "@intentic/workspace-ignore";

// Where the workspace's git lives and what its root repo leaves out: each repo's real git dir on the history volume,
// and the one exclude list the /work repo and the history root scope share (history/history.ts), so history and the
// Changes review agree.

// git's empty-tree hash; the diff base for a scope's first snapshot (also an unborn HEAD in git/changes.ts).
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Real git dir for a daemon-created repo, passed to --separate-git-dir so the in-worktree .git is a rewritable pointer.
// Dir name is the URI-encoded repo id, one filesystem entry per (possibly nested) id.
export const repoGitDir = (historyRoot: string, name: string): string => join(historyRoot, "gits", encodeURIComponent(name));

// Secret/junk patterns every scope excludes; uncheckpointed, appended after the carve-outs, so they always win.
const COMMON_PRIVATE_FILES = new Set([".secrets.json", "claude.json"]);
// Written without the trailing slash: a directory-only rule does not match a SYMLINK of that name, and an agent's
// worktree mirrors these dirs in as symlinks. It also matches rootPathIsExcluded below, which has always gone by name.
export const COMMON_EXCLUDES = [".env*", "!.env.example", ...COMMON_PRIVATE_FILES, ...IGNORED_DIRS];

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

// The heavy-dir patterns that the root repo excludes via COMMON_EXCLUDES; project repos need the same protection,
// but their .gitignore is the owner's business, so the daemon writes to `.git/info/exclude` instead: git reads it for
// every worktree, the main one included, and it never touches the working tree. Only dirs not already ignored are
// appended. Unanchored, at any depth, as COMMON_EXCLUDES is for the root: the trees that grow to 50k files are as often
// nested (`backend/.venv`, `.local/lib/node_modules`, every `__pycache__`) as at the top. Untracked files only, as any
// exclude is: a dependency dir the project chose to commit keeps showing its edits.
const PROJECT_EXCLUDE_NOTE = "# intentic: heavy dependency dirs excluded by default to keep the Changes panel fast.";
// What IGNORED_DIRS grays in the tree but a project may still version, so its own .gitignore keeps the say: a Yarn
// Berry project commits `.yarn/releases` (scratch.ts keeps `.yarn` as work for the same reason), a JavaScript action
// its built `dist/`. An exclude would hide a new file there from status and from a stage-all. `.git` is git's own.
const PROJECT_VERSIONED_DIRS: ReadonlySet<string> = new Set([".git", ".yarn", "dist"]);
export const projectExcludes = (): string[] => [...IGNORED_DIRS].filter((dir) => !PROJECT_VERSIONED_DIRS.has(dir)).map((dir) => `${dir}/`);

// The git dir whose info/exclude a checkout reads. A `.git` file points elsewhere (`--separate-git-dir`, a linked
// worktree), relative to the checkout when not absolute; a linked worktree's own dir names, in `commondir`, the shared
// one git actually reads info/exclude from. A `.git` directory is the git dir itself, a missing one no repo (which the
// caller skips), and a missing `commondir` a git dir that is its own common dir.
const excludeGitDir = async (dir: string): Promise<string> => {
    const dotGit = join(dir, ".git");
    const pointer = (await lstat(dotGit).catch(undefinedIfMissing))?.isFile() === true ? await readFile(dotGit, "utf8") : undefined;
    const named = pointer?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    const gitDir = named === undefined ? dotGit : resolve(dir, named);
    const common = (await readFile(join(gitDir, "commondir"), "utf8").catch(undefinedIfMissing))?.trim();
    return common === undefined || common === "" ? gitDir : resolve(gitDir, common);
};

// Every pattern a build of this file may have written under the note: the block it owns is the run of these right
// after it, so an owner's own line below the block ends it rather than being taken for one of ours.
const WRITABLE_PATTERNS: ReadonlySet<string> = new Set([...IGNORED_DIRS].map((dir) => `${dir}/`));

// Where the note and the patterns under it sit in the file's rows, end exclusive; undefined with no note.
const noteBlock = (rows: readonly string[]): { readonly at: number; readonly end: number } | undefined => {
    const at = rows.findIndex((row) => row.trim() === PROJECT_EXCLUDE_NOTE);
    if (at === -1) {
        return undefined;
    }
    let end = at + 1;
    while (end < rows.length && WRITABLE_PATTERNS.has(rows[end]?.trim() ?? "")) {
        end += 1;
    }
    return { at, end };
};

// `current` with the block under PROJECT_EXCLUDE_NOTE made exactly `lines`, less any the owner's own rows already hold:
// a pattern added since is written, one dropped since (an earlier build also excluded `dist/` and `.yarn/`) removed.
// Without the note the block is appended; the owner's rows around it are kept as they are.
export const convergedExclude = (current: string, lines: readonly string[]): string => {
    const rows = current === "" ? [] : current.replace(/\n$/u, "").split("\n");
    const block = noteBlock(rows);
    const before = block === undefined ? rows : rows.slice(0, block.at);
    const after = block === undefined ? [] : rows.slice(block.end);
    const held = new Set([...before, ...after].map((row) => row.trim()));
    const ours = lines.filter((line) => !held.has(line));
    const converged = [...before, ...(ours.length === 0 ? [] : [PROJECT_EXCLUDE_NOTE, ...ours]), ...after];
    return converged.length === 0 ? "" : `${converged.join("\n")}\n`;
};

// Converges project repos' info/exclude onto the heavy-dir list. Called from scanAll alongside syncRootExcludes, so a
// fresh clone's panel never sees its node_modules as 12k changes.
export const syncProjectExcludes = async (workspaceRoot: string, repoIds: readonly string[]): Promise<void> => {
    const lines = projectExcludes();
    for (const repo of repoIds) {
        const gitDir = await excludeGitDir(join(workspaceRoot, repo));
        try {
            await access(join(gitDir, "info"));
        } catch {
            continue;
        }
        const target = join(gitDir, "info", "exclude");
        const current = (await readFile(target, "utf8").catch(undefinedIfMissing)) ?? "";
        const next = convergedExclude(current, lines);
        if (next !== current) {
            await writeFile(target, next);
        }
    }
};

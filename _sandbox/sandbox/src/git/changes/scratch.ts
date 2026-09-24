import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ScratchPath, ScratchReason } from "@intentic/sandbox-contract";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { currentRepos } from "../../workspace/watch/repo-watch.js";
import { materializedPaths } from "./changes-porcelain.js";
import { readOnFeed } from "../feed/checkout-feed.js";

// What a stage-everything leaves out: untracked paths shaped like scratch, judged by shape since the names scratch
// arrives under are invented fresh each time. Only untracked paths are judged; the index is somebody's decision.

// Hidden directories projects keep on purpose; any other new hidden directory is a tool's or an agent's own.
const KEPT_HIDDEN_DIRS = new Set([
    ".agents",
    ".buildkite",
    ".cargo",
    ".changeset",
    ".circleci",
    ".claude",
    ".claude-plugin",
    ".codex",
    ".config",
    ".cursor",
    ".devcontainer",
    ".forgejo",
    ".gemini",
    ".gitea",
    ".githooks",
    ".github",
    ".gitlab",
    ".husky",
    STATE_DIR,
    ".mvn",
    ".opencode",
    ".storybook",
    ".vitepress",
    ".vscode",
    ".well-known",
    ".windsurf",
    ".yarn",
    ".zed",
]);

// Files nobody means to version: logs, process ids, heap and CPU dumps, backups, merge rejects, editor swap files.
const BYPRODUCT_EXTENSIONS = new Set([".bak", ".cpuprofile", ".heapprofile", ".heapsnapshot", ".log", ".orig", ".pid", ".rej", ".swo", ".swp", ".tmp"]);
const BYPRODUCT_NAMES = new Set([".DS_Store", "Thumbs.db"]);

// Bytes: the size GitHub starts warning at, past which a new file is a dump or a download rather than source.
export const OVERSIZED_BYTES = 50 * 1024 * 1024;

// Hidden files a workspace root keeps on purpose; any other new one there is scratch, since a root holding repositories
// is no project of its own. Visible files stay work: a report written at the top is often the very thing asked for.
const KEPT_ROOT_FILES = new Set([".editorconfig", ".gitattributes", ".gitignore", ".ignore", ".mcp.json"]);

export interface ScratchScope {
    // The workspace's own repo, which never records another repository: a checkout inside it is scratch, where a project
    // repo keeps one as a gitlink since it may be the owner's submodule.
    readonly root: boolean;
    // That root when its projects are the repositories inside it, so no dotfile new at its top configures one.
    readonly container: boolean;
}

// `workspaceRoot` is the main tree's root, whichever checkout of `repo` is being captured.
export const scratchScopeOf = async (repo: string, workspaceRoot: string): Promise<ScratchScope> => ({
    root: repo === "root",
    container: repo === "root" && (await currentRepos(workspaceRoot)).length > 0,
});

// Last segment of a repository-relative path; a directory's trailing slash is not a segment.
const nameOf = (path: string): string => path.replace(/\/$/, "").split("/").at(-1) ?? "";

const topLevel = (path: string): boolean => !path.replace(/\/$/, "").includes("/");

const directoryReason = (path: string): ScratchReason | undefined => {
    const name = nameOf(path);
    return name.startsWith(".") && !KEPT_HIDDEN_DIRS.has(name) ? "hidden" : undefined;
};

const fileReason = (path: string, bytes: number, scope: ScratchScope): ScratchReason | undefined => {
    const name = nameOf(path);
    if (BYPRODUCT_NAMES.has(name) || BYPRODUCT_EXTENSIONS.has(extname(name).toLowerCase())) {
        return "byproduct";
    }
    if (bytes > OVERSIZED_BYTES) {
        return "oversized";
    }
    return scope.container && topLevel(path) && name.startsWith(".") && !KEPT_ROOT_FILES.has(name) ? "root" : undefined;
};

// Every directory from `outer` (a wholly new one) down to the one holding `path`, outermost first: all of them new.
const newDirectoriesOn = (outer: string, path: string): string[] => {
    const inner = path.slice(outer.length).replace(/\/$/, "").split("/").slice(0, -1);
    return [outer, ...inner.map((_, index) => `${outer}${inner.slice(0, index + 1).join("/")}/`)];
};

const untracked = async (dir: string, args: readonly string[], git: GitRunner): Promise<string[]> =>
    materializedPaths((await git(dir, ["ls-files", "--others", "--exclude-standard", "-z", ...args])).stdout);

const isDirectoryRow = (path: string): boolean => path.endsWith("/");

// A file that vanished between listing and stat counts as empty rather than failing the read.
const sizesOf = async (dir: string, paths: readonly string[]): Promise<Map<string, number>> =>
    new Map(
        await Promise.all(
            paths.filter((path) => !isDirectoryRow(path)).map(async (path) => [path, (await lstat(join(dir, path)).catch(() => undefined))?.size ?? 0] as const),
        ),
    );

// The collapsed listing's own rows: a wholly new directory judged by its name, a loose file by its shape.
const judgeOuter = async (dir: string, outer: readonly string[], scope: ScratchScope, found: Map<string, ScratchReason>): Promise<void> => {
    const sizes = await sizesOf(dir, outer);
    for (const path of outer) {
        const reason = isDirectoryRow(path) ? directoryReason(path) : fileReason(path, sizes.get(path) ?? 0, scope);
        if (reason !== undefined) {
            found.set(path, reason);
        }
    }
};

// The entry holding one path found inside an open new directory: an inner directory by its name, else the path itself.
const insideVerdict = (
    path: string,
    outer: string,
    bytes: number,
    scope: ScratchScope,
    found: ReadonlyMap<string, ScratchReason>,
): readonly [string, ScratchReason] | undefined => {
    const directories = newDirectoriesOn(outer, path).filter((directory) => directory !== path);
    if (directories.some((directory) => found.has(directory))) {
        return undefined;
    }
    for (const directory of directories) {
        const reason = directoryReason(directory);
        if (reason !== undefined) {
            return [directory, reason];
        }
    }
    const reason = isDirectoryRow(path) ? (scope.root ? "checkout" : undefined) : fileReason(path, bytes, scope);
    return reason === undefined ? undefined : [path, reason];
};

// Inside the new directories no rule took whole. A checkout of its own lists as one `dir/` row git does not descend
// into; a listing too large to read leaves them carried as they are, which is what every capture did before this.
const judgeInside = async (dir: string, open: readonly string[], scope: ScratchScope, found: Map<string, ScratchReason>, git: GitRunner): Promise<void> => {
    const inside = await untracked(dir, ["--", ...open], git).catch(() => []);
    const sizes = await sizesOf(dir, inside);
    for (const path of inside) {
        const outer = open.find((candidate) => path.startsWith(candidate));
        const verdict = outer === undefined ? undefined : insideVerdict(path, outer, sizes.get(path) ?? 0, scope, found);
        if (verdict !== undefined) {
            found.set(verdict[0], verdict[1]);
        }
    }
};

// The untracked paths of the checkout at `dir` that no capture stages, one entry per scratch tree, sorted by path.
export const scratchOf = (dir: string, scope: ScratchScope, git: GitRunner = defaultGit): Promise<ScratchPath[]> =>
    readOnFeed(`scratch\u0000${String(scope.root)}\u0000${String(scope.container)}`, dir, git, () => readScratch(dir, scope, git));

const readScratch = async (dir: string, scope: ScratchScope, git: GitRunner): Promise<ScratchPath[]> => {
    // Collapsed: a wholly new directory is one row however much it holds, so this stays small over any scratch tree.
    const outer = await untracked(dir, ["--directory", "--no-empty-directory"], git);
    if (outer.length === 0) {
        return [];
    }
    const found = new Map<string, ScratchReason>();
    await judgeOuter(dir, outer, scope, found);
    const open = outer.filter((path) => isDirectoryRow(path) && !found.has(path));
    if (open.length > 0) {
        await judgeInside(dir, open, scope, found, git);
    }
    return withCounts(dir, found, git);
};

// Files and bytes per entry; a checkout is not walked, and a directory too large to list goes uncounted.
const withCounts = async (dir: string, found: ReadonlyMap<string, ScratchReason>, git: GitRunner): Promise<ScratchPath[]> => {
    const directories = [...found].filter(([path, reason]) => isDirectoryRow(path) && reason !== "checkout").map(([path]) => path);
    const listed = directories.length === 0 ? [] : await untracked(dir, ["--", ...directories], git).catch(() => undefined);
    const sizes = await sizesOf(dir, [...(listed ?? []), ...found.keys()]);
    const counted = (path: string, reason: ScratchReason): ScratchPath => {
        if (reason === "checkout" || (isDirectoryRow(path) && listed === undefined)) {
            return { path, reason };
        }
        const files = isDirectoryRow(path) ? (listed ?? []).filter((file) => file.startsWith(path) && !isDirectoryRow(file)) : [path];
        return { path, reason, files: files.length, bytes: files.reduce((total, file) => total + (sizes.get(file) ?? 0), 0) };
    };
    return [...found].map(([path, reason]) => counted(path, reason)).toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

// Runs a stage-everything with the scratch excluded, git never reading it however large. Through a pathspec file,
// since a scratch list has no argv ceiling; `run` receives the flags to append.
export const withScratchExcluded = async <T>(scratch: readonly ScratchPath[], run: (pathspecArgs: readonly string[]) => Promise<T>): Promise<T> => {
    if (scratch.length === 0) {
        return run([]);
    }
    const specs = await mkdtemp(join(tmpdir(), "intentic-scratch-"));
    try {
        const file = join(specs, "pathspecs");
        await writeFile(file, [".", ...scratch.map((entry) => `:(exclude,literal)${entry.path}`)].join("\0"));
        return await run([`--pathspec-from-file=${file}`, "--pathspec-file-nul"]);
    } finally {
        await rm(specs, { recursive: true, force: true });
    }
};

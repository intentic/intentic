import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execBounded } from "@intentic/base/process";

// The files under some of a repository's package directories, and a bounded read of each: what the dependency graph's
// usage and a package's module graph are read from. Git lists them when the repository is one, tracked and untracked
// alike minus what .gitignore drops; a plain walk past the always-ignored directories otherwise.

// A file past this is generated or vendored, never a module someone wrote imports into.
const MAX_SOURCE_BYTES = 1_000_000;
// Reads in flight at once: enough to keep the disk busy, few enough that one view's read never starves the other
// backends sharing this process.
const READ_CONCURRENCY = 24;
// `git ls-files` of a large untracked tree, and how long it may take before the walk answers instead.
const MAX_LISTING_CHARS = 16 * 1024 * 1024;
const LISTING_DEADLINE_MS = 30_000;

// The directories the walk never enters: dependency installs, build output and tool caches, as the workspace's own
// attention filter names them (@intentic/workspace-ignore's IGNORED_DIRS, which an extension does not reach). Only the
// walk of a folder that is not a git repository reads it; git's own listing drops what .gitignore names.
const IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    ".tmp",
    "dist",
    ".cache",
    ".turbo",
    ".next",
    ".angular",
    ".pnpm-store",
    ".yarn",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".gradle",
]);

const walk = async (root: string, dir: string, out: string[]): Promise<void> => {
    // allow(silent-catch): a directory gone mid-walk or unreadable has no files to offer.
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
                await walk(root, path, out);
            }
        } else if (entry.isFile()) {
            out.push(path);
        }
    }
};

// Tracked and untracked files under `dirs`, as git sees them. Each dir is a literal pathspec, so a glob character in a
// directory's name (`[slug]`) never matches a sibling. `--no-optional-locks` keeps a read off the index lock a land takes.
const listedByGit = async (repoDir: string, dirs: readonly string[]): Promise<string[]> => {
    const { stdout } = await execBounded(
        "git",
        ["--no-optional-locks", "-C", repoDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...dirs.map((dir) => `:(literal)${dir}`)],
        { maxOutput: MAX_LISTING_CHARS, timeoutMs: LISTING_DEADLINE_MS },
    );
    return [...new Set(stdout.split("\0").filter((path) => path !== ""))];
};

/** Every file under `dirs` (repository-relative), as repository-relative paths. */
export const packageFiles = async (repoDir: string, dirs: readonly string[]): Promise<string[]> => {
    if (dirs.length === 0) {
        return [];
    }
    try {
        return await listedByGit(repoDir, dirs);
    } catch {
        // Not a git repository (or git is missing): the walk sees the same files, less what a .gitignore would drop.
        const out: string[] = [];
        for (const dir of dirs) {
            await walk(repoDir, dir, out);
        }
        return out;
    }
};

// The text of the regular file at `file` when it is one within the bound, asked of the file as opened rather than of its
// name, so a name swapped between the two (for a pipe, which would hold the read, or a file past the bound) is never
// read. Opened without waiting, so a pipe named like a file never holds the open.
const readBounded = async (file: string): Promise<string | undefined> => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_SOURCE_BYTES) {
            return undefined;
        }
        const bytes = await handle.readFile();
        // Asked again of what was read, for a file that grew in between.
        return bytes.length > MAX_SOURCE_BYTES ? undefined : bytes.toString("utf8");
    } finally {
        await handle.close();
    }
};

/** Reads each of `paths` that is a file under the size bound and hands it to `visit`, a bounded number at a time. */
export const readSources = async (repoDir: string, paths: readonly string[], visit: (path: string, text: string) => void): Promise<void> => {
    let next = 0;
    const reader = async (): Promise<void> => {
        while (next < paths.length) {
            const path = paths[next++]!;
            // allow(silent-catch): a file listed and then removed, or unreadable, has nothing to say about imports.
            const text = await readBounded(join(repoDir, path)).catch(() => undefined);
            if (text !== undefined) {
                visit(path, text);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, reader));
};

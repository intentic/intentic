import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";

// The files under some of a repository's package directories, and a bounded read of each: what the dependency graph's
// usage and a package's module graph are read from. Git lists them when the repository is one, tracked and untracked
// alike minus what .gitignore drops; a plain walk past the always-ignored directories otherwise.

// A file past this is generated or vendored, never a module someone wrote imports into.
const MAX_SOURCE_BYTES = 1_000_000;
// Reads in flight at once: enough to keep the disk busy, few enough that one view's read never starves a turn's.
const READ_CONCURRENCY = 24;

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

/** Every file under `dirs` (repository-relative), as repository-relative paths. */
export const packageFiles = async (repoDir: string, dirs: readonly string[], git: GitRunner = defaultGit): Promise<string[]> => {
    if (dirs.length === 0) {
        return [];
    }
    try {
        const { stdout } = await git(repoDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...dirs]);
        return [...new Set(stdout.split("\0").filter((path) => path !== ""))];
    } catch {
        // Not a git repository (or git is missing): the walk sees the same files, less what a .gitignore would drop.
        const out: string[] = [];
        for (const dir of dirs) {
            await walk(repoDir, dir, out);
        }
        return out;
    }
};

/** Reads each of `paths` that is a file under the size bound and hands it to `visit`, a bounded number at a time. */
export const readSources = async (repoDir: string, paths: readonly string[], visit: (path: string, text: string) => void): Promise<void> => {
    let next = 0;
    const reader = async (): Promise<void> => {
        while (next < paths.length) {
            const path = paths[next++]!;
            const file = join(repoDir, path);
            // allow(silent-catch): a file listed and then removed, or unreadable, has nothing to say about imports.
            const size = await stat(file).then(
                ({ size: bytes }) => bytes,
                () => undefined,
            );
            if (size === undefined || size > MAX_SOURCE_BYTES) {
                continue;
            }
            // allow(silent-catch): as above, for a file that went between the stat and the read.
            const text = await readFile(file, "utf8").catch(() => undefined);
            if (text !== undefined) {
                visit(path, text);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, reader));
};

import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/* Repo discovery, the extension's own copy: every directory under the workspace root owning a `.git` entry,
 * as ABSOLUTE dirs (the repo-links scan joins compose paths against them, and relative dirs would silently
 * depend on the backend host's cwd). The daemon's discovery is richer — reserved names, scaffold roles, the
 * shared ignore vocabulary — but none of that is importable from an extension (the SDK boundary), and none of
 * it changes which repos can hold a compose file. Deliberately the same walk shape: skip hidden and junk
 * dirs, stop at the first .git boundary, bounded depth. */

const IGNORED = new Set(["node_modules", "dist", "build", "out", "coverage", "target", "vendor", "tmp", "refs", "public"]);
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_DEPTH = 4;
const MAX_DIRS = 10_000;

const hasGitEntry = async (dir: string): Promise<boolean> => {
    try {
        await access(join(dir, ".git"));
        return true;
    } catch {
        return false;
    }
};

export const discoverRepoDirs = async (root: string): Promise<string[]> => {
    const repos: string[] = [];
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || visited >= MAX_DIRS) {
            return;
        }
        visited += 1;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED.has(entry.name) || !SEGMENT.test(entry.name)) {
                continue;
            }
            const child = join(dir, entry.name);
            if (await hasGitEntry(child)) {
                repos.push(child);
                continue;
            }
            await walk(child, depth + 1);
        }
    };
    await walk(root, 1);
    return repos.toSorted();
};

// The RepoScanDeps read (komodo-repos.ts): an absolute path, absent-as-undefined.
export const readFileOrUndefined = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

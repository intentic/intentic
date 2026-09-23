import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";

export interface ListedDir {
    readonly path: string;
    // Root-relative POSIX path; "" is the root itself.
    readonly rel: string;
    readonly name: string;
}

// Lists `root`, then each subdirectory `visit` returns, down to `maxDepth` levels below root, one readdir per directory
// and none past `maxDirs`. Only subdirectories that are not hidden, junk or a link are offered, so none of those is entered.
export const walkDirs = async (
    root: string,
    limits: { readonly maxDepth: number; readonly maxDirs?: number },
    visit: (dir: ListedDir, entries: readonly Dirent[], subdirs: readonly ListedDir[]) => Promise<readonly ListedDir[]>,
): Promise<void> => {
    let budget = limits.maxDirs ?? Number.POSITIVE_INFINITY;
    const walk = async (dir: ListedDir, depth: number): Promise<void> => {
        if (budget <= 0) {
            return;
        }
        budget -= 1;
        const entries = await readdir(dir.path, { withFileTypes: true }).catch(() => []);
        const subdirs = entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name))
            .map((entry) => ({ path: join(dir.path, entry.name), rel: dir.rel === "" ? entry.name : `${dir.rel}/${entry.name}`, name: entry.name }));
        const next = await visit(dir, entries, subdirs);
        if (depth < limits.maxDepth) {
            await Promise.all(next.map((subdir) => walk(subdir, depth + 1)));
        }
    };
    await walk({ path: root, rel: "", name: "" }, 0);
};

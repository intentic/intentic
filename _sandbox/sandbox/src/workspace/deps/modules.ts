import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceModule } from "@intentic/sandbox-contract";
import { walkDirs } from "../layout/dir-walk.js";
import { hasGitEntry } from "../layout/repo-discovery.js";

// Modules of a repo: every directory with a self-naming package.json, as repo-relative dirs, used to group changed
// files in review panels. A filesystem walk, not package-graph.ts's pnpm-workspace globs: grouping is about where a
// file lives, not a dependency edge. Bounded, and prunes nested repos too, which carry their own {repo} id.

// packages/<group>/<pkg> is the deepest layout worth walking; past that isn't what anyone means by module.
const MAX_DEPTH = 3;
// Runaway guard for a pathological tree: stop the scan rather than stall the daemon.
const MAX_DIRS = 5_000;

// The name a directory's manifest declares; undefined when there's no manifest, it doesn't parse, or it names nothing.
const manifestName = async (dir: string): Promise<string | undefined> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    } catch {
        return undefined;
    }
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" && name !== "" ? name : undefined;
};

export const readModules = async (repoDir: string): Promise<WorkspaceModule[]> => {
    const modules: WorkspaceModule[] = [];
    await walkDirs(repoDir, { maxDepth: MAX_DEPTH, maxDirs: MAX_DIRS }, async (_dir, _entries, subdirs) => {
        const nested = await Promise.all(subdirs.map((subdir) => hasGitEntry(subdir.path)));
        const inside = subdirs.filter((_, index) => !nested[index]);
        for (const subdir of inside) {
            const name = await manifestName(subdir.path);
            if (name !== undefined) {
                modules.push({ dir: subdir.rel, name });
            }
        }
        // Keeps walking through a module: a package holding packages is ordinary, not a boundary.
        return inside;
    });
    // A one-package repo declares itself at its root, read only when nothing under it claimed a file first.
    const own = modules.length === 0 ? await manifestName(repoDir) : undefined;
    return own === undefined ? modules : [{ dir: "", name: own }];
};

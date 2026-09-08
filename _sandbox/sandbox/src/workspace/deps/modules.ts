import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceModule } from "@intentic/sandbox-contract";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";

// Modules of a repo: every directory with a self-naming package.json, as repo-relative dirs, used to group changed
// files in review panels. A filesystem walk, not package-graph.ts's pnpm-workspace globs: grouping is about where a
// file lives, not a dependency edge. Bounded, and prunes nested repos too, which carry their own {repo} id.

// packages/<group>/<pkg> is the deepest layout worth walking; past that isn't what anyone means by module.
const MAX_DEPTH = 3;
// Runaway guard for a pathological tree: stop the scan rather than stall the daemon.
const MAX_DIRS = 5_000;

// The name a directory's manifest declares; undefined when there's no manifest, it doesn't parse, or it names nothing.
const manifestName = (dir: string): string | undefined => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
        return undefined;
    }
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" && name !== "" ? name : undefined;
};

export const readModules = (repoDir: string): WorkspaceModule[] => {
    const modules: WorkspaceModule[] = [];
    let visited = 0;
    const walk = (rel: string, depth: number): void => {
        if (depth > MAX_DEPTH || visited >= MAX_DIRS) {
            return;
        }
        visited += 1;
        let entries;
        try {
            entries = readdirSync(join(repoDir, rel), { withFileTypes: true });
        } catch {
            // Unreadable dir (permissions, a dangling symlink) contributes no modules; the rest of the repo still does.
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) {
                continue;
            }
            const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
            if (existsSync(join(repoDir, child, ".git"))) {
                continue;
            }
            const name = manifestName(join(repoDir, child));
            if (name !== undefined) {
                modules.push({ dir: child, name });
            }
            // Keeps walking through a module: a package holding packages is ordinary, not a boundary.
            walk(child, depth + 1);
        }
    };
    walk("", 0);
    // A one-package repo declares itself at its root, read only when nothing under it claimed a file first.
    const own = modules.length === 0 ? manifestName(repoDir) : undefined;
    return own === undefined ? modules : [{ dir: "", name: own }];
};

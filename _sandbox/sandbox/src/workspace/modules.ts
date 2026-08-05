import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceModule } from "@intentic/sandbox-contract";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";

/* The modules of one repo: every directory owning a package.json that NAMES itself, as repo-relative dirs.
 * This is what the review panels group changed files under when the reader has asked for modules instead of
 * paths — "which part of the system did this touch" is the first question of any review, and a manifest name
 * is the only thing in the tree that answers it in the words the team actually uses.
 *
 * A filesystem walk rather than package-graph.ts's pnpm-workspace globs, which the DEPENDENCY graph is right
 * to use: pnpm's view is what a dependency edge means, while grouping is about where a file lives. A package
 * outside the globs (a scratch app, a vendored tool) still holds files a reviewer thinks of by its name, and a
 * repo with no pnpm workspace at all has modules just the same.
 *
 * The walk is bounded on both axes and prunes exactly what every other walk here prunes (hidden dirs, junk
 * dirs) plus nested repos — a repo inside a repo carries its own {repo} id, and its files arrive under that id
 * rather than under its parent's. */

// packages/<group>/<pkg> is the deepest layout worth walking for; past that a "module" is not what anyone
// means by the word.
const MAX_DEPTH = 3;
// Runaway guard for a pathological tree, matching repo-discovery's shape (a dir farm stops the scan rather
// than stalling the daemon).
const MAX_DIRS = 5_000;

// The name a directory's manifest declares, or undefined when there is no manifest, it doesn't parse, or it
// names nothing — none of which is a module.
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
            // Unreadable dir (permissions, a symlink that went nowhere) — it contributes no modules, and the
            // rest of the repo still does.
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
            // Kept walking THROUGH a module: a package that holds packages (an app with its own operator UI,
            // a plugin dir) is the ordinary case, not a boundary.
            walk(child, depth + 1);
        }
    };
    walk("", 0);
    // A repo that is ONE package declares itself at its root. Read only when nothing under it claimed a file
    // first — otherwise a monorepo's private root manifest ("@acme/root", a holder for scripts) would become
    // the module every loose file at the top level belongs to, which is a name no reviewer would recognize.
    const own = modules.length === 0 ? manifestName(repoDir) : undefined;
    return own === undefined ? modules : [{ dir: "", name: own }];
};

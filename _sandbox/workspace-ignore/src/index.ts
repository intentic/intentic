import { readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { IGNORED_DIRS, isAgentWorktreePath, isBrowserProfilePath, isReferencePath } from "./constants.js";

// The single source of "what the workspace views gray out". Both the file tree (walkWorkspaceTree) and content
// search (searchWorkspaceFiles) build an IgnoreScope from here and consult it per entry, so the two views agree on
// exactly which paths are ignored — grayed (still listed + openable) in the tree, skipped by default in search.
//
// This is NOT a security boundary: nothing is hidden, and nothing is blocked from being read or written. "Ignored"
// means only "not part of the tracked project" — junk/generated dirs, .gitignore'd paths, and the heavy
// browser-profile subtree. A role-based access floor will layer on top later. In the tree, ignored directories are
// listed but not eagerly walked (they lazy-load their children on expand), so a giant node_modules / .git can't
// blow the walk's entry budget.

// IGNORED_DIRS + the path predicates (browser profiles, agent worktrees) are the browser-safe ignore constants —
// they live in ./constants (no node deps) so the platform's browser bundle can import them via
// `@intentic/workspace-ignore/constants`. Re-exported here so the daemon keeps importing from the package root,
// and the node-based .gitignore scope layers on top.
export { IGNORED_DIRS, isAgentWorktreePath, isBrowserProfilePath, isPublicPath, isReferencePath, PUBLIC_DIR, REFERENCE_DIR } from "./constants.js";

// A .gitignore matcher rooted at `base` (root-relative, forward-slash). Patterns in it apply to paths relative
// to that directory.
type GitignoreLayer = { base: string; ig: Ignore };

// One immutable node of the accumulated .gitignore state at a point in the walk. Threaded down the recursion:
// entering a directory yields a child scope with that directory's .gitignore (if any) appended; siblings never
// see each other's patterns because each descend() copies the layer list.
export type IgnoreScope = {
    isIgnored(name: string, relPath: string, isDir: boolean): boolean;
    descend(absDir: string, relDir: string): Promise<IgnoreScope>;
};

const makeScope = (layers: readonly GitignoreLayer[]): IgnoreScope => ({
    isIgnored(name, relPath, isDir) {
        // Junk denylist (dirs) + the browser-profile, agent-worktree, and reference-shelf subtrees.
        if (isDir && IGNORED_DIRS.has(name)) {
            return true;
        }
        if (isBrowserProfilePath(relPath) || isAgentWorktreePath(relPath) || isReferencePath(relPath)) {
            return true;
        }
        // .gitignore, nearest (deepest) matcher with an opinion wins.
        // ponytail: deepest-.gitignore-wins is approximate for cross-file negation; covers realistic layouts.
        //           Upgrade to full git precedence only if a real repo trips it.
        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i]!;
            const rel = layer.base === "" ? relPath : posix.relative(layer.base, relPath);
            if (rel === "" || rel.startsWith("..")) {
                continue;
            }
            const result = layer.ig.test(isDir ? `${rel}/` : rel);
            if (result.ignored) {
                return true;
            }
            if (result.unignored) {
                return false;
            }
        }
        return false;
    },
    async descend(absDir, relDir) {
        const content = await readFile(join(absDir, ".gitignore"), "utf8").catch(() => undefined);
        if (content === undefined) {
            return this;
        }
        return makeScope([...layers, { base: relDir.split(sep).join("/"), ig: ignore().add(content) }]);
    },
});

// Build the scope for the walk root. A root-level .gitignore is read by the first descend the walker makes (the
// walkers descend() on the root dir before reading its entries). Paths passed to isIgnored are root-relative.
export const createIgnoreScope = (): IgnoreScope => makeScope([]);

// Root-relative, forward-slash path for `abs` under `base` — the path space the tree/search/file routes speak.
export const toRelPath = (base: string, abs: string): string => relative(base, abs).split(sep).join("/");

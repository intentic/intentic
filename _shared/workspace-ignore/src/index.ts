import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { IGNORED_DIRS, isAgentWorktreePath, isBrowserProfilePath, isReferencePath } from "./constants.js";

// The single source of what workspace views gray out: the tree and search both build an IgnoreScope from here, so they
// agree on what's ignored. Not a security boundary: nothing is hidden or blocked, ignored means only not part of the
// tracked project. Ignored directories stay listed but lazy-load, so a giant node_modules can't blow the walk's budget.

// Re-exported from ./constants (browser-safe, no node deps), so the daemon imports from the package root.
export {
    IGNORED_DIRS,
    isAgentWorktreePath,
    isBrowserProfilePath,
    isPublicPath,
    isReferencePath,
    PUBLIC_DIR,
    REFERENCE_DIR,
    scannerPruneGlobs,
} from "./constants.js";

// A .gitignore matcher rooted at `base` (root-relative, forward-slash); patterns apply to paths relative to that
// directory.
type GitignoreLayer = { base: string; ig: Ignore };

// One immutable node of accumulated .gitignore state, threaded down the recursion; each descend() copies the layer list
// so siblings never see each other's patterns.
export type IgnoreScope = {
    isIgnored(name: string, relPath: string, isDir: boolean): boolean;
    descend(absDir: string, relDir: string): Promise<IgnoreScope>;
    // descend() for a walker that already holds the directory's .gitignore text; undefined when it has none.
    layer(relDir: string, gitignore: string | undefined): IgnoreScope;
};

/** Compiles a .gitignore's text into a matcher. A matcher remembers every path it has answered for (ignore@7 keeps a
 *  per-instance cache only `add()` clears), so whoever holds one decides how long: a walk's own reads for one walk, the
 *  daemon's held reads until its watcher or their time bound says the folder changed (dir-reads.ts). */
export type Matchers = (gitignore: string) => Ignore;

/** A fresh matcher per layer, held by nothing but the scope that asked for it. */
export const compileGitignore: Matchers = (gitignore) => ignore().add(gitignore);

/** Matchers shared by text for as long as the returned function is held: one walk's worth, for a walk that layers the
 *  same .gitignore under many folders. */
export const walkMatchers = (): Matchers => {
    const compiled = new Map<string, Ignore>();
    return (gitignore) => {
        let matcher = compiled.get(gitignore);
        if (matcher === undefined) {
            matcher = compileGitignore(gitignore);
            compiled.set(gitignore, matcher);
        }
        return matcher;
    };
};

const makeScope = (layers: readonly GitignoreLayer[], compile: Matchers): IgnoreScope => ({
    isIgnored(name, relPath, isDir) {
        // Junk denylist (dirs), plus the browser-profile, agent-worktree and reference-shelf subtrees.
        if (isDir && IGNORED_DIRS.has(name)) {
            return true;
        }
        if (isBrowserProfilePath(relPath) || isAgentWorktreePath(relPath) || isReferencePath(relPath)) {
            return true;
        }
        // Nearest (deepest) matcher wins; approximates git's precedence for cross-file negation.
        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i]!;
            // Layers are the walk's ancestors and paths arrive normalized, so "under base" is a prefix test.
            if (layer.base !== "" && !relPath.startsWith(`${layer.base}/`)) {
                continue;
            }
            const rel = layer.base === "" ? relPath : relPath.slice(layer.base.length + 1);
            if (rel === "") {
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
        // Only a directory with no .gitignore has no rules; one that could not be read would make everything under it
        // count as tracked, which a walk then descends into and a portability bundle then carries.
        const content = await readFile(join(absDir, ".gitignore"), "utf8").catch((error: unknown) => {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") {
                return undefined;
            }
            throw error;
        });
        return this.layer(relDir, content);
    },
    layer(relDir, gitignore) {
        if (gitignore === undefined) {
            return this;
        }
        return makeScope([...layers, { base: relDir.split(sep).join("/"), ig: compile(gitignore) }], compile);
    },
});

// Build the scope for the walk root. A root-level .gitignore is read by the first descend the walker makes; paths
// passed to isIgnored are root-relative. `matchers` decides how long compiled rules live; by default only as long as
// the scopes that use them.
export const createIgnoreScope = (matchers: Matchers = compileGitignore): IgnoreScope => makeScope([], matchers);

// A scope that ignores nothing, for a tree that is not a project: an unpacked archive's `.gitignore`, `node_modules`
// and `.git` are its own contents, and hiding them would hide what the archive actually holds.
export const NO_IGNORES: IgnoreScope = {
    isIgnored: () => false,
    descend: async () => NO_IGNORES,
    layer: () => NO_IGNORES,
};

// Root-relative, forward-slash path for `abs` under `base`, the path space the tree/search/file routes speak.
export const toRelPath = (base: string, abs: string): string => relative(base, abs).split(sep).join("/");

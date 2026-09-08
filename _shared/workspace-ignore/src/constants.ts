import { STATE_DIR } from "@intentic/constants";
// Browser-safe ignore constants: no node imports, so the platform's browser bundle can import them via the
// `@intentic/workspace-ignore/constants` subpath without pulling in node:fs/node:path. index.ts re-exports these for
// the daemon and layers the node-based .gitignore scope on top.

// Conservative: ambiguous dirs (build, target, vendor, out) are left to .gitignore, not force-grayed here.
const GIT_DIR = ".git";

export const IGNORED_DIRS = new Set([
    "node_modules",
    GIT_DIR,
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

// Reserved top-level shelf for reference material: grayed, lazy-loaded, excluded from search and history.
export const REFERENCE_DIR = "refs";

// The outbox: a reserved top-level dir served publicly; its existence alone is the publish switch.
export const PUBLIC_DIR = "public";

// Root-relative paths only: both predicates match the first segment, so a repo's own refs/ or public/ subdir stays
// ordinary content. Callers with an absolute path must relativize first (toRelPath).
const firstSegment = (relPath: string): string | undefined => relPath.split(/[\\/]/).find((segment) => segment.length > 0);
export const isReferencePath = (relPath: string): boolean => firstSegment(relPath) === REFERENCE_DIR;
export const isPublicPath = (relPath: string): boolean => firstSegment(relPath) === PUBLIC_DIR;

// Browser-login profiles are a Chromium user-data dir, thousands of rewritten files; ignored to lazy-load it.
// The group folder name, spelled here since this file takes no node or contract imports; a test pins it.
const BROWSER_PROFILE_GROUP = "local";

export const isBrowserProfilePath = (path: string): boolean => {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
    const i = segments.indexOf(STATE_DIR);
    return i !== -1 && segments[i + 1] === BROWSER_PROFILE_GROUP && segments[i + 2] === "browser";
};

// Agent worktrees are throwaway checkouts; ignored so the walk doesn't duplicate every project in the tree.
const AGENT_WORKTREE_SEGMENTS = [".claude", "worktrees"] as const;

export const isAgentWorktreePath = (path: string): boolean => {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments.some((segment, i) => segment === AGENT_WORKTREE_SEGMENTS[0] && segments[i + 1] === AGENT_WORKTREE_SEGMENTS[1]);
};

// Prune globs for a content scanner, derived from the same branches isIgnored tests so the two can't drift. An
// optimization, never the authority: it may only prune what the sweep would discard anyway.
export const scannerPruneGlobs = (includeIgnored: boolean): string[] =>
    includeIgnored
        ? [`!**/${GIT_DIR}`]
        : [
              ...[...IGNORED_DIRS].map((dir) => `!**/${dir}`),
              // Root-anchored, matching isReferencePath's rule: a bare `!refs` would prune a repo's refs/ at any depth.
              `!/${REFERENCE_DIR}`,
              `!**/${AGENT_WORKTREE_SEGMENTS.join("/")}`,
          ];

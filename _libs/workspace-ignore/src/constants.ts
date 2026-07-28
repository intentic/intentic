// Browser-SAFE ignore constants: NO node imports, so the platform's browser bundle can import them via the
// `@intentic/workspace-ignore/constants` subpath without pulling this package's node:fs/node:path deps. The
// package root (index.ts) re-exports these for the daemon, and layers the node-based .gitignore scope on top.

// Kept conservative on purpose: dirs that are essentially never browsed as source AND rarely committed, so the
// static list can't wrongly gray a dir some project actually tracks. Ambiguous ones (build, target, vendor,
// coverage, out) are intentionally absent — .gitignore catches those accurately. `.tmp` is a scratch dir (e.g.
// .intentic/codex/.tmp) that can hold thousands of files. `.git` lives here too: a dir you browse as history, not
// source, so it grays and lazy-loads like node_modules (its contents stay readable on demand).
export const IGNORED_DIRS = new Set([
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

// The workspace's reference shelf: a reserved TOP-LEVEL directory where the agent or the user drops material
// that is consulted, not worked on — a third-party repo cloned to compare against, vendored docs, a tarball.
// Everything under it stays readable and addressable by full path, but it is out of the workspace's focus:
// grayed + lazy-loaded in the tree, skipped by default search, never discovered as a workspace repo, never
// dependency-scanned or remote-synced, never snapshotted by history. The classification is an ATTENTION
// boundary, not an access one — same philosophy as the rest of this package.
export const REFERENCE_DIR = "refs";

// Root-relative paths only: the predicate matches the FIRST segment, so a repo's own `refs/` subdir
// ("myrepo/refs") stays ordinary content. Callers holding an absolute path must relativize first (toRelPath).
export const isReferencePath = (relPath: string): boolean => relPath.split(/[\\/]/).find((segment) => segment.length > 0) === REFERENCE_DIR;

// The persisted browser-login profiles (.intentic/browser/<platform>) are a Chromium user-data dir: thousands of
// constantly-rewritten files (Cookies, Login Data, …). Treated as ignored so the tree grays + lazy-loads the
// subtree instead of eagerly walking it, and the file watcher skips its churn. Not a read block — its files are
// served on demand like any other ignored path.
export const isBrowserProfilePath = (path: string): boolean => {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
    const i = segments.indexOf(".intentic");
    return i !== -1 && segments[i + 1] === "browser";
};

// Agent worktrees (<repo>/.claude/worktrees/<name>) are throwaway full checkouts of their repo. Not junk by
// name — the rest of .claude (skills, settings) is real config — but walking a checkout duplicates every
// project in the tree, lets vitest-project detection list a stale copy of the whole monorepo, and burns the
// walk's entry budget. Treated as ignored so the subtree grays + lazy-loads and the watcher skips its churn.
export const isAgentWorktreePath = (path: string): boolean => {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments.some((segment, i) => segment === ".claude" && segments[i + 1] === "worktrees");
};

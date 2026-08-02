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

/* The workspace's OUTBOX, and the reference shelf's mirror image: a reserved TOP-LEVEL directory whose files
 * the sandbox serves on the public internet. Where `refs/` is what the world sends in, this is what the work
 * sends out — the process-free half of preview (a panel needs a running dev server; a file needs nothing), and
 * the file-shaped way an agent hands a result to someone who has no Intentic account.
 *
 * Unlike the shelf it is NOT ensured at boot, and that asymmetry is the whole safety story: its EXISTENCE is
 * the switch. No directory, nothing served; `mkdir public` turns publishing on and deleting it turns publishing
 * off, with no second piece of state to disagree with the first. An empty shelf is harmless furniture, so the
 * daemon can leave one lying around; a directory that is public by definition is the one thing nobody should
 * ever find by accident.
 *
 * In every OTHER respect it is ordinary workspace content — searched, watched, ungrayed in the tree — because
 * what you published is precisely what you want to be able to find again. The one exception is repo discovery,
 * which reserves the name: a folder of artifacts is not a project. */
export const PUBLIC_DIR = "public";

// Root-relative paths only: both predicates match the FIRST segment, so a repo's own `refs/` or `public/` subdir
// ("myrepo/public" — Vite, Next and Laravel all ship one) stays ordinary content. Callers holding an absolute
// path must relativize first (toRelPath).
const firstSegment = (relPath: string): string | undefined => relPath.split(/[\\/]/).find((segment) => segment.length > 0);
export const isReferencePath = (relPath: string): boolean => firstSegment(relPath) === REFERENCE_DIR;
export const isPublicPath = (relPath: string): boolean => firstSegment(relPath) === PUBLIC_DIR;

// The persisted browser-login profiles (.intentic/browser/<platform>) are a Chromium user-data dir: thousands of
// constantly-rewritten files (Cookies, Login Data, …). Treated as ignored so the tree grays + lazy-loads the
// subtree instead of eagerly walking it, and the file watcher skips its churn. Not a read block — its files are
// served on demand like any other ignored path.
//
// `output` is the one child that is NOT profile churn: it holds what the agent's browsing PRODUCED —
// screenshots, page snapshots, downloads — which is the opposite kind of file. Written deliberately, one at a
// time, and meant to be looked at: the chat renders those screenshots inline and offers to open them here. It
// was only ever caught by this rule because it happened to live under the same directory.
export const isBrowserProfilePath = (path: string): boolean => {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
    const i = segments.indexOf(".intentic");
    return i !== -1 && segments[i + 1] === "browser" && segments[i + 2] !== "output";
};

// Agent worktrees (<repo>/.claude/worktrees/<name>) are throwaway full checkouts of their repo. Not junk by
// name — the rest of .claude (skills, settings) is real config — but walking a checkout duplicates every
// project in the tree, lets vitest-project detection list a stale copy of the whole monorepo, and burns the
// walk's entry budget. Treated as ignored so the subtree grays + lazy-loads and the watcher skips its churn.
export const isAgentWorktreePath = (path: string): boolean => {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments.some((segment, i) => segment === ".claude" && segments[i + 1] === "worktrees");
};

import { STATE_DIR } from "@intentic/constants";
// Browser-SAFE ignore constants: NO node imports, so the platform's browser bundle can import them via the
// `@intentic/workspace-ignore/constants` subpath without pulling this package's node:fs/node:path deps. The
// package root (index.ts) re-exports these for the daemon, and layers the node-based .gitignore scope on top.

// Kept conservative on purpose: dirs that are essentially never browsed as source AND rarely committed, so the
// static list can't wrongly gray a dir some project actually tracks. Ambiguous ones (build, target, vendor,
// coverage, out) are intentionally absent: .gitignore catches those accurately. `.tmp` is a scratch dir (e.g.
// .intentic/secrets/auth/codex/.tmp) that can hold thousands of files. `.git` lives here too: a dir you browse as history, not
// source, so it grays and lazy-loads like node_modules (its contents stay readable on demand).
// Named because it is the one entry `includeIgnored` never lifts: see scannerPruneGlobs.
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

// The workspace's reference shelf: a reserved TOP-LEVEL directory where the agent or the user drops material
// that is consulted, not worked on, a third-party repo cloned to compare against, vendored docs, a tarball.
// Everything under it stays readable and addressable by full path, but it is out of the workspace's focus:
// grayed + lazy-loaded in the tree, skipped by default search, never discovered as a workspace repo, never
// dependency-scanned or remote-synced, never snapshotted by history. The classification is an ATTENTION
// boundary, not an access one, same philosophy as the rest of this package.
export const REFERENCE_DIR = "refs";

/* The workspace's OUTBOX, and the reference shelf's mirror image: a reserved TOP-LEVEL directory whose files
 * the sandbox serves on the public internet. Where `refs/` is what the world sends in, this is what the work
 * sends out, the process-free half of preview (a panel needs a running dev server; a file needs nothing), and
 * the file-shaped way an agent hands a result to someone who has no Intentic account.
 *
 * Unlike the shelf it is NOT ensured at boot, and that asymmetry is the whole safety story: its EXISTENCE is
 * the switch. No directory, nothing served; `mkdir public` turns publishing on and deleting it turns publishing
 * off, with no second piece of state to disagree with the first. An empty shelf is harmless furniture, so the
 * daemon can leave one lying around; a directory that is public by definition is the one thing nobody should
 * ever find by accident.
 *
 * In every OTHER respect it is ordinary workspace content, searched, watched, ungrayed in the tree, because
 * what you published is precisely what you want to be able to find again. The one exception is repo discovery,
 * which reserves the name: a folder of artifacts is not a project. */
export const PUBLIC_DIR = "public";

// Root-relative paths only: both predicates match the FIRST segment, so a repo's own `refs/` or `public/` subdir
// ("myrepo/public". Vite, Next and Laravel all ship one) stays ordinary content. Callers holding an absolute
// path must relativize first (toRelPath).
const firstSegment = (relPath: string): string | undefined => relPath.split(/[\\/]/).find((segment) => segment.length > 0);
export const isReferencePath = (relPath: string): boolean => firstSegment(relPath) === REFERENCE_DIR;
export const isPublicPath = (relPath: string): boolean => firstSegment(relPath) === PUBLIC_DIR;

// The persisted browser-login profiles (.intentic/local/browser/<capability>) are a Chromium user-data dir: thousands of
// constantly-rewritten files (Cookies, Login Data, …). Treated as ignored so the tree grays + lazy-loads the
// subtree instead of eagerly walking it, and the file watcher skips its churn. Not a read block, its files are
// served on demand like any other ignored path.
/* The group folder the profiles sit in, spelled here rather than imported. This file is the BROWSER-SAFE half of
 * the package, no node imports, and no @intentic/sandbox-contract either, since the whole point is that the
 * platform's web bundle can take it without dragging zod and the contract surface along. The cost of that is one
 * copy of a name, and the thing that keeps the copy honest lives on the other side: workspace-state.test.ts pins
 * the browser entry's full path and names this file in the failure, so moving the group breaks a test that says
 * where to come. */
const BROWSER_PROFILE_GROUP = "local";

export const isBrowserProfilePath = (path: string): boolean => {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
    const i = segments.indexOf(STATE_DIR);
    return i !== -1 && segments[i + 1] === BROWSER_PROFILE_GROUP && segments[i + 2] === "browser";
};

// Agent worktrees (<repo>/.claude/worktrees/<name>) are throwaway full checkouts of their repo. Not junk by
// name, the rest of .claude (skills, settings) is real config, but walking a checkout duplicates every
// project in the tree, lets vitest-project detection list a stale copy of the whole monorepo, and burns the
// walk's entry budget. Treated as ignored so the subtree grays + lazy-loads and the watcher skips its churn.
// The two segments are named so the predicate and the scanner glob below cannot drift apart.
const AGENT_WORKTREE_SEGMENTS = [".claude", "worktrees"] as const;

export const isAgentWorktreePath = (path: string): boolean => {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments.some((segment, i) => segment === AGENT_WORKTREE_SEGMENTS[0] && segments[i + 1] === AGENT_WORKTREE_SEGMENTS[1]);
};

/* THE SAME IGNORE MODEL, AS PRUNE GLOBS FOR A CONTENT SCANNER (ripgrep).
 *
 * A scanner that doesn't know what the sweep rejects reads the whole rejected subtree, reports every match in
 * it, and has all of that thrown away by the post-filter. Measured on a workspace with a 14 GB reference
 * shelf: 173 785 files walked to answer from 4 686, 1.4 GB of scanner JSON parsed to keep 42 MB, and 9.6 s
 * spent on a query with ten hits. The prune list used to be hand-written next to the scanner, which is why it
 * knew about IGNORED_DIRS and had never heard of the shelf or of agent worktrees.
 *
 * So it is derived HERE, from the same branches `isIgnored` tests, and the drift that caused this cannot
 * recur: a rule added to the predicate without a glob added beside it is a visible omission in one file
 * rather than an invisible one across two packages.
 *
 * AN OPTIMISATION, NEVER THE AUTHORITY. These globs may only ever prune what the sweep would have discarded
 * anyway; the sweep's admitted set stays the thing results are filtered against. A glob that is too wide
 * silently loses files, which is the worst failure a search has, so anything approximate (per-directory
 * .gitignore, whose precedence here is deliberately not git's) is left out and paid for in the post-filter.
 *
 * `includeIgnored` lifts exactly what it lifts in the sweep: the junk dirs, the shelf and the worktrees all
 * become searchable together. `.git` is the one that never lifts, it is browsed as history, not as source.
 *
 * The agent plane (`.intentic`) is absent on purpose: it is the ENGINE's security floor rather than an
 * attention boundary, it is default-deny instead of default-allow, and it is derived from the state table.
 * See the engine's own DENIED_GLOBS. */
export const scannerPruneGlobs = (includeIgnored: boolean): string[] =>
    includeIgnored
        ? [`!**/${GIT_DIR}`]
        : [
              ...[...IGNORED_DIRS].map((dir) => `!**/${dir}`),
              // ROOT-ANCHORED, matching isReferencePath's first-segment rule. A bare `!refs` would match the
              // basename at any depth and prune a repo's own `refs/` directory, which is ordinary content.
              // The anchor is relative to the scanner's working directory, so it only means "the shelf" when
              // that directory is the workspace root, which is how the engine spawns it.
              `!/${REFERENCE_DIR}`,
              `!**/${AGENT_WORKTREE_SEGMENTS.join("/")}`,
          ];

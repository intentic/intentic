import { STATE_DIR } from "@intentic/constants";
import { SEARCHABLE_STATE_PATHS, WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";

// Where the index lives, root-relative. Inside the denied-by-default state dir, so it can never surface itself.
export const IQ_DIR = `${STATE_DIR}/cache/iq`;

/* THE AGENT PLANE IS OUT OF SCOPE BY DEFAULT — an allow-list over `.intentic`, not a deny-list.
 *
 * This floor used to enumerate what to hide (the index, auth, sessions, artifacts, runtime, browser) and let
 * everything else under `.intentic` rank as workspace content. That is the hand-kept-list failure the state
 * table exists to end, and it failed exactly as that shape always does: nobody added the loop ledger, so 98 kB
 * of iteration history ranked against source; nobody added `extensions/`, so cloned third-party extension code
 * answered questions about this codebase; nobody added the vector sidecar, which sits BESIDE `cache/iq` and so
 * escaped the index's own self-exclusion.
 *
 * So the question is inverted and the answer imported: `SEARCHABLE_STATE_PATHS` is the table's own derivation
 * of the slice a person or agent WROTE — reviewable config (`versioned`) plus authored content (`authored`:
 * drafts, staged docs, workspace extensions). Those stay searchable because excluding them would trade one
 * blind spot for another — "find the reddit draft" and "edit the automation" are ordinary asks. Everything
 * else under `.intentic` — every ledger, cache, profile, checkout, and every store ADDED LATER — is out of
 * scope by construction, the same default-deny the portability classes are built on. This also stops the index
 * copying capability tokens into search text: `capabilities.json` is `secret` and unversioned, so it fell out
 * of scope the moment the list was derived instead of remembered. */
const intenticTails = (paths: readonly string[]): string[] => paths.map((path) => path.slice(`${STATE_DIR}/`.length));
const ALLOWED_TAILS = intenticTails(SEARCHABLE_STATE_PATHS);

// Matching mirrors the table's own prefix semantics (staleQueryKeys): a dir tail keeps its trailing slash and
// claims its subtree; a file tail is a prefix so a name family stays one entry. The ancestor case is what lets
// the walk DESCEND toward a nested allowed dir rather than pruning at its parent.
const isAllowedTail = (tail: string): boolean =>
    ALLOWED_TAILS.some((allowed) => tail.startsWith(allowed) || allowed === `${tail}/` || allowed.startsWith(`${tail}/`));

/* Matched at ANY depth, not just the workspace root: a workspace can contain checkouts that are themselves
 * intentic workspaces, and a root-only test let a nested one's index (a multi-gigabyte index.db plus its
 * spool) rank as a search result. The engine's always-on floor — every engine (sweep, ripgrep, git, cursor
 * replay) filters emitted paths through it, and `--ignored` never lifts it. */
export const isIqDenied = (relPath: string): boolean => {
    const segments = relPath.split("/").filter((segment) => segment !== "");
    const index = segments.indexOf(STATE_DIR);
    if (index === -1) {
        return false;
    }
    const tail = segments.slice(index + 1).join("/");
    // The state dir itself descends — pruning here would hide the allowed slice along with the rest.
    return tail !== "" && !isAllowedTail(tail);
};

/* The rg prune, derived from the same table: one `!` glob per non-searchable entry, so ripgrep never walks the
 * heavy subtrees (sessions, browser profiles, caches) at all. An OPTIMISATION, not the authority — a store the
 * table doesn't know (a stray file at the `.intentic` root, tomorrow's undeclared tree) is not in these globs,
 * and the post-filter above is what actually keeps it out of results. */
export const DENIED_GLOBS = intenticTails(WORKSPACE_STATE_FILES.map((file) => file.path))
    .filter((tail) => !isAllowedTail(tail.replace(/\/$/, "")))
    .map((tail) => `!**/${STATE_DIR}/${tail.replace(/\/$/, "")}`);

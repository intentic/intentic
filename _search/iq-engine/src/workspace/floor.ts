import { STATE_DIR } from "@intentic/constants";
import { SEARCHABLE_STATE_PATHS, WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";

// Where the index lives, root-relative, inside the denied-by-default state dir so it can never surface itself.
export const IQ_DIR = `${STATE_DIR}/local/cache/iq`;

// An allow-list over `.intentic`, not a deny-list: SEARCHABLE_STATE_PATHS is the versioned/authored slice a person or
// agent wrote; everything else is out of scope by construction, including anything added later.
const intenticTails = (paths: readonly string[]): string[] => paths.map((path) => path.slice(`${STATE_DIR}/`.length));
const ALLOWED_TAILS = intenticTails(SEARCHABLE_STATE_PATHS);

// Mirrors the table's prefix semantics: a dir tail keeps its slash and claims its subtree, a file tail is a prefix.
// Lets the walk descend toward a nested allowed dir rather than pruning at its parent.
const isAllowedTail = (tail: string): boolean =>
    ALLOWED_TAILS.some((allowed) => tail.startsWith(allowed) || allowed === `${tail}/` || allowed.startsWith(`${tail}/`));

// Matched at any depth: a workspace can contain checkouts that are themselves intentic workspaces. The engine's
// always-on floor; every engine filters emitted paths through it, and `--ignored` never lifts it.
export const isIqDenied = (relPath: string): boolean => {
    const segments = relPath.split("/").filter((segment) => segment !== "");
    const index = segments.indexOf(STATE_DIR);
    if (index === -1) {
        return false;
    }
    const tail = segments.slice(index + 1).join("/");
    // The state dir itself descends; pruning here would hide the allowed slice along with the rest.
    return tail !== "" && !isAllowedTail(tail);
};

// rg prune from the same table: an optimization, not the authority; the post-filter above is the real gate.
export const DENIED_GLOBS = intenticTails(WORKSPACE_STATE_FILES.map((file) => file.path))
    .filter((tail) => !isAllowedTail(tail.replace(/\/$/, "")))
    .map((tail) => `!**/${STATE_DIR}/${tail.replace(/\/$/, "")}`);

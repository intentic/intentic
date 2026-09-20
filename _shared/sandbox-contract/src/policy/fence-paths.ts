import { PUBLIC_DIR, STATE_DIR } from "@intentic/constants";

// The path arithmetic a workspace fence is made of: whether a path is inside a folder, whether one set of folders
// covers another, and what a fenced tree may still list. Pure and shared, because the daemon refuses on these answers
// and the browser draws on them, and two implementations would disagree at exactly the boundary that matters.

// Workspace-relative, forward-slash, no climb: segments are folded so `a/./b` and `a/b` are one path, and a path that
// climbs above the root folds to `undefined` rather than to something inside it.
// The root itself is "" — a real answer, not a missing one.
export const foldPath = (raw: string): string | undefined => {
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
        return undefined;
    }
    const segments: string[] = [];
    for (const segment of raw.split(/[\\/]/)) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment !== "..") {
            segments.push(segment);
            continue;
        }
        if (segments.pop() === undefined) {
            return undefined;
        }
    }
    return segments.join("/");
};

// Whether `path` is `folder` or lives under it, by segment rather than by string prefix: `app2` is not inside `app`.
// An unfoldable path is inside nothing.
export const pathInsideFolder = (folder: string, path: string): boolean => {
    const outer = foldPath(folder);
    const inner = foldPath(path);
    if (outer === undefined || inner === undefined) {
        return false;
    }
    return outer === "" || inner === outer || inner.startsWith(`${outer}/`);
};

// "Change the sandbox" as paths: the daemon's own configuration, and the outbox the internet reads. One list, read by
// the persona hook that judges a turn's writes and by the area schema that decides what a grant may name.
export const SANDBOX_PATHS: readonly string[] = [STATE_DIR, PUBLIC_DIR];

// Whether a path is one of those folders or sits inside one, by segment: `publications` is not `public`.
// No area may name such a folder, which is what keeps a fence from handing anyone the config that decides what agents
// may do — the enumerated control-plane table (state/workspace-state.ts) locks named entries, not the whole tree.
export const isSandboxPath = (path: string): boolean => SANDBOX_PATHS.some((folder) => pathInsideFolder(folder, path));

// A fence: the folders a caller may touch, or undefined for the whole workspace. Undefined and `[]` are deliberately
// different answers — no fence at all, versus a fence that admits nothing.
export type Fence = readonly string[] | undefined;

/** Whether the fence admits this path at all: reading it, writing it, searching in it. */
export const fenceAllows = (fence: Fence, path: string): boolean => fence === undefined || fence.some((folder) => pathInsideFolder(folder, path));

/**
 * Whether a fenced tree may still LIST this path: everything the fence allows, plus the ancestors leading down to it.
 * Without the ancestors a fence on `finance/reports` would hide `finance` itself and leave the folder unreachable.
 */
export const fenceReaches = (fence: Fence, path: string): boolean => {
    if (fenceAllows(fence, path)) {
        return true;
    }
    const inner = foldPath(path);
    return inner !== undefined && (fence ?? []).some((folder) => pathInsideFolder(inner, folder));
};

/**
 * Whether `outer` covers `inner`: every folder the inner fence admits is one the outer fence admits too. The question
 * behind every narrowing-only rule — handing work across, inheriting a fence — since a fence that covers another can
 * safely stand in for it.
 */
export const fenceCovers = (outer: Fence, inner: Fence): boolean => {
    if (outer === undefined) {
        return true;
    }
    if (inner === undefined) {
        return false;
    }
    return inner.every((folder) => fenceAllows(outer, folder));
};

/**
 * The tighter of two fences: what a turn may touch when a persona's folders meet the member's own. Undefined on both
 * sides is the whole workspace; either side alone narrows to itself.
 */
export const fenceIntersection = (left: Fence, right: Fence): Fence => {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    // A folder survives only where one side contains it; the containing side's folder is already the narrower of the
    // pair, so taking each side's contained folders and deduping gives the intersection with no overlap left over.
    const kept = [...left.filter((folder) => fenceAllows(right, folder)), ...right.filter((folder) => fenceAllows(left, folder))];
    return [...new Set(kept.map((folder) => foldPath(folder) ?? folder))];
};

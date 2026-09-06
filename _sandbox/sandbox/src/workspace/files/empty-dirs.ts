import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope, toRelPath } from "@intentic/workspace-ignore";

/* BARREN DIRECTORIES, folders whose entire subtree holds no files: the debris file moves leave behind, since
 * git carries no directories and so nothing ever cleans them up. The explorer offers to sweep them, and this is
 * where the offer's FACTS come from.
 *
 * It is a walk of its own rather than a reading of the tree walk's output, and the reason is the tree walk's
 * entry budget. That budget bounds the RESPONSE (5000 entries, breadth-first, so the shallow levels a collapsed
 * explorer shows always arrive complete), which means every directory below the cut comes back unlisted, and an
 * unlisted directory is UNKNOWN, never empty. In this workspace the budget runs out around depth four, so the
 * sweep could see the workspace root and nothing inside any repository in it: an empty `_sandbox/host` left by
 * a move was invisible to the one feature that exists to find it.
 *
 * Emptiness does not fit in that budget because it is not a listing, it is a fact ABOUT a listing, and the
 * cheapest thing in the tree: an empty directory costs one readdir and answers with nothing. So this walk
 * visits every directory the ignore rules allow, spends no stat calls (the tree walk pays those, for sizes),
 * and returns paths rather than entries. What it costs on a real workspace is one readdir per non-ignored
 * directory, about 1,600 of them here, well under the walk it runs beside.
 *
 * WHAT COUNTS AS CONTENT is anything that is not a directory this walk may itself descend into:
 *   - a file, obviously, however small;
 *   - a SYMLINK, which is somebody's deliberate work and never debris (deleting one deletes the link, not what
 *     it points at), and which is never followed here, so no cycle can exist and nothing outside the workspace
 *     is ever reached;
 *   - an IGNORED directory (node_modules, dist, the reference shelf, .gitignore'd paths), because ignored
 *     territory is off-limits to the offer, and a folder that holds one is not a folder anyone should be
 *     invited to sweep;
 *   - a LOCKED directory (the daemon's own control plane), for the same reason the tree walk refuses to
 *     descend into one: its contents are not the owner's to tidy.
 * A directory whose every child is a barren directory is barren; a directory with no children at all is the
 * base case. That is exactly the rule the explorer used to compute over the tree it happened to have, which is
 * why moving it here changed which directories are found and not which ones qualify.
 *
 * The FIXTURES rule (leave the reference shelf, the outbox and the daemon's own folders alone, empty or not)
 * stays in the browser, in pages/workspace/emptyDirs.ts: it is policy about what to OFFER, not a fact about the
 * filesystem, and the client is where the rest of that policy (settling, exemptions) already lives. */

// One readdir each. Reached only by a workspace with tens of thousands of non-ignored directories, where the
// sweep is not the interesting problem anyway; past it the walk stops descending, so it UNDER-reports (an
// unfinished directory is unknown, and unknown is never barren) rather than claiming something it did not look at.
const MAX_SCAN_DIRS = 20_000;

// A subtree's answer: whether the directory itself is barren, and every barren path found inside it, in the
// order the explorer draws them (a barren parent immediately above the branch it heads).
interface Scanned {
    readonly barren: boolean;
    readonly found: readonly string[];
}

const NOTHING: Scanned = { barren: false, found: [] };

/* Every barren directory in the workspace, root-relative, in tree order (parents before children, siblings
 * alphabetically), so the sweep's list reads down the screen the way the explorer does.
 *
 * Complete: no entry budget, nothing deferred, no lazily-loaded half. A caller receives the whole set or, in the
 * pathological case the cap exists for, a prefix of it. */
export const scanBarrenDirs = async (root: string, options?: { maxDirs?: number }): Promise<string[]> => {
    const base = resolve(root);
    let budget = options?.maxDirs ?? MAX_SCAN_DIRS;

    const visit = async (abs: string, rel: string, parentScope: IgnoreScope): Promise<Scanned> => {
        if (budget <= 0) {
            return NOTHING;
        }
        budget--;
        // This directory's own .gitignore layers onto the ones above it, exactly as in the tree walk, so the two
        // views agree on what is ignored.
        const scope = await parentScope.descend(abs, rel);
        const dirents = await readdir(abs, { withFileTypes: true }).catch(() => undefined);
        if (dirents === undefined) {
            // Unreadable is UNKNOWN, not empty: a directory nobody can list is not one to offer to delete.
            return NOTHING;
        }
        // `isDirectory()` is false for a symlink (the dirent describes the link, not its target), which is what
        // makes a link content here without any further test.
        const children = dirents
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => ({ name: dirent.name, abs: join(abs, dirent.name), path: toRelPath(base, join(abs, dirent.name)) }))
            .filter((child) => !scope.isIgnored(child.name, child.path, true) && !isLockedWorkspacePath(child.path));
        // Anything this walk will not descend into is content, and content is what stops the branch here.
        let all = children.length === dirents.length;
        children.sort((left, right) => left.name.localeCompare(right.name));
        const scanned = await Promise.all(children.map((child) => visit(child.abs, child.path, scope)));

        const found: string[] = [];
        for (const result of scanned) {
            if (!result.barren) {
                all = false;
            }
            found.push(...result.found);
        }
        // The directory itself goes FIRST, ahead of the branch it heads, so the output reads as a tree.
        return all ? { barren: true, found: [rel, ...found] } : { barren: false, found };
    };

    const { found } = await visit(base, "", createIgnoreScope());
    // A workspace root that is itself barren drops out (its path is the empty string, and there is nothing to
    // sweep there but the workspace); everything inside it stands.
    return found.filter((path) => path !== "");
};

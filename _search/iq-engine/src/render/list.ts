import { encodeCursor } from "./cursor.js";
import type { ListPage, RankedGroup } from "../types.js";
import type { Rendered } from "./text.js";

/* Paging for a caller that renders its own list of rows, the workspace search panel, instead of the agent's
 * text capsule.
 *
 * renderText decides a page by SIMULATING the capsule: it formats each group and stops when the token budget
 * runs out. Asking it to size a scrollable list means the number of files that come back depends on how many
 * characters the matched lines happen to hold, and means building 160 KB of text the browser throws away. Here
 * the page is what a list actually costs: rows. Whole files, in the plan's order, up to a hit ceiling and a
 * file ceiling, whichever binds first, with the first file always admitted so a single huge file still shows.
 *
 * No capsule, so no `text`; the caller reads the structured result. The cursor is still handed back, a list
 * that says "showing the first 300" needs somewhere to go, but nothing is spooled behind it: the continuation
 * re-runs the verb and slices at the offset, which for `find` is one rg pass and always current, where a spool
 * is megabytes on disk per keystroke and stale the moment a file changes. */
export const renderList = (groups: readonly RankedGroup[], offset: number, page: ListPage, cursorId: string, ceiling = false): Rendered => {
    let shownGroups = 0;
    let shownHits = 0;
    for (const group of groups.slice(offset)) {
        // Whole files only, half a file's matches under its own header reads as the file having that many.
        // The first is admitted regardless, so one file with more hits than the ceiling still shows.
        if (shownGroups > 0 && (shownGroups >= page.files || shownHits + group.hits.length > page.hits)) {
            break;
        }
        shownGroups += 1;
        shownHits += group.hits.length;
    }
    /* More than this page exists either because more groups were FOUND than fit, or because the scan stopped
     * at its own ceiling and never looked further. The second one is invisible from the groups alone: a
     * ceilinged scan hands back exactly the files it read, so a page that showed all of them would read as
     * the last page and take the caller's Load-more away while matches remained. The ceiling stops on a file
     * boundary, so the offset below still names a whole file and the next page resumes exactly there. */
    const truncated = offset + shownGroups < groups.length || ceiling;
    const totalHits = groups.reduce((sum, group) => sum + group.hits.length, 0);
    return {
        text: "",
        shownGroups,
        shownHits,
        truncated,
        ...(truncated ? { cursor: encodeCursor(cursorId, offset + shownGroups) } : {}),
        exitCode: totalHits > 0 ? 0 : 1,
    };
};

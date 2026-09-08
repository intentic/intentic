import { encodeCursor } from "./cursor.js";
import type { ListPage, RankedGroup } from "../types.js";
import type { Rendered } from "./text.js";

// Pages a caller's row list (the workspace panel) by rows, not by simulating the capsule's token budget: whole files up
// to a hit or file ceiling, whichever binds first. No `text`; the cursor re-runs and slices rather than spooling.
export const renderList = (groups: readonly RankedGroup[], offset: number, page: ListPage, cursorId: string, ceiling = false): Rendered => {
    let shownGroups = 0;
    let shownHits = 0;
    for (const group of groups.slice(offset)) {
        // Whole files only, so a header never shows with only some of its matches; the first file is always admitted.
        if (shownGroups > 0 && (shownGroups >= page.files || shownHits + group.hits.length > page.hits)) {
            break;
        }
        shownGroups += 1;
        shownHits += group.hits.length;
    }
    // True if groups remain past this page, or the scan hit its own ceiling, indistinguishable from groups alone.
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

import type { GitChangesResponse } from "@intentic-app/api-contract";
import { router } from "../../../router";
import { useLayout } from "../../useLayout";
import { queryClient } from "../../queryPersistence";
import { changesKey, fetchChanges, fileDiffQuery } from "../../workspace/useChanges";
import type { WarmBand, WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";
import { warmRows } from "./warmRows";

/* THE WORKSPACE REVIEW'S WISH LIST, the change list, and the diffs behind its rows.
 *
 * This is the work surface: what an agent just wrote, and what the user is about to read, stage and commit.
 * Every row of it costs a daemon read of two whole file texts, and until now that read happened only while the
 * review panel was mounted, so arriving at Changes and clicking the first row paid the trip in full, because
 * the panel's own walk had started half a second earlier. Warming it from anywhere in the app is the whole
 * difference between "instant" and "instant if you lingered".
 *
 * THE ORDER IS THE PANEL'S OWN reading order, conflicts first (they block the commit), then staged, then
 * unstaged, repo by repo. Reading ahead in a different order than the list is drawn in would warm the rows the
 * reader reaches last.
 *
 * THE LIST IS READ FROM THE CACHE, not observed. The shell's Workspace badge already holds an observer on it
 * from every page in the app, so it is there to be read; declaring it as a wish as well is what covers the case
 * where it is not (a fresh connection, an invalidation) without this file having to own a second observer whose
 * lifetime nothing manages. */

/* HOW CLOSE THE READER IS, and the floor under the answer, which is the point of this file.
 *
 * THE LIST BEING ON SCREEN IS `now`. These rows are not one click away when the Changes panel is the open one:
 * they ARE the thing being read, and the +/− beside each of them is worked out from exactly this read
 * (useCodeStats), so a band that put them behind the board's cards put the numbers on the screen in front of the
 * user behind reads for screens that are not.
 *
 * FROM ANYWHERE ELSE IN THE APP THEY ARE `near`, AND NEVER LOWER. This is the review the user commits from, and
 * every turn that ends drops the whole of it, list and every diff together, since the diffs are filed under the
 * list's own key (useChanges' changesKey) and a turn ending invalidates that family. So the moment the work
 * becomes reviewable is the moment this all goes cold, and it has to be read back before the user walks over to
 * look at it.
 *
 * It used to be `work` off the workspace route, which put it behind the board, every card's transcript and file
 * list, plus the focused conversation's whole review, up to two hundred reads ahead of it at a quarter-second
 * apiece. A turn ending on the agents board therefore emptied this and then re-read it last, which is the one
 * ordering that guarantees the panel is cold exactly when it is about to be opened. It is now read ahead of the
 * board from everywhere: the trade is that opening a card on a busy board pays its round trip more often, and
 * that is the cheaper of the two waits, a card opens onto a conversation that streams in either way, while the
 * review opens onto numbers that must already be right. */
const band = (): WarmBand => {
    if (router.currentRoute.value.name !== `workspace`) {
        return `near`;
    }
    const layout = useLayout();
    // Collapsed counts as closed: the aside is not drawn at all, so the rows are a click on the mode switch away
    // rather than under the reader's eye (WorkspaceDesktop's `sidebarOpen`).
    return layout.sidebarPanel.value === `changes` && !layout.sidebarCollapsed.value ? `now` : `near`;
};

export const changesWarmSource = (): readonly WarmTask[] => {
    // The list rides the same band as its rows rather than a fixed lower one: nothing here can be warmed until it
    // lands, so a list left in a band below its own rows is a plan that reads the second thing first, forever.
    const list = warmQuery(`changes:list`, band(), { queryKey: changesKey(), queryFn: fetchChanges });
    const held = queryClient.getQueryData<GitChangesResponse>(changesKey());
    if (held === undefined) {
        // Nothing to walk yet, the list itself is the only wish, and the rows follow on the beat after it lands.
        return [list];
    }
    const rows = warmRows(held.repos ?? []).map((row) =>
        warmQuery(`diff:${row.repo}:${row.side}:${row.path}`, band(), fileDiffQuery(row.repo, row.path, row.side)),
    );
    return [list, ...rows];
};

import type { GitChangesResponse } from "@intentic-app/api-contract";
import { router } from "../../../router";
import { useLayout } from "../../useLayout";
import { queryClient } from "../../queryPersistence";
import { changesKey, fetchChanges, fileDiffQuery } from "../../workspace/useChanges";
import type { WarmBand, WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";
import { warmRows } from "./warmRows";

/* THE WORKSPACE REVIEW'S WISH LIST — the change list, and the diffs behind its rows.
 *
 * This is the work surface: what an agent just wrote, and what the user is about to read, stage and commit.
 * Every row of it costs a daemon read of two whole file texts, and until now that read happened only while the
 * review panel was mounted — so arriving at Changes and clicking the first row paid the trip in full, because
 * the panel's own walk had started half a second earlier. Warming it from anywhere in the app is the whole
 * difference between "instant" and "instant if you lingered".
 *
 * THE ORDER IS THE PANEL'S OWN reading order — conflicts first (they block the commit), then staged, then
 * unstaged, repo by repo. Reading ahead in a different order than the list is drawn in would warm the rows the
 * reader reaches last.
 *
 * THE LIST IS READ FROM THE CACHE, not observed. The shell's Workspace badge already holds an observer on it
 * from every page in the app, so it is there to be read; declaring it as a wish as well is what covers the case
 * where it is not (a fresh connection, an invalidation) without this file having to own a second observer whose
 * lifetime nothing manages. */

/* HOW CLOSE THE READER IS, in the two things that say so — which page they are on, and which sidebar panel is
 * open on it.
 *
 * THE LIST BEING ON SCREEN IS `now`, and that is the whole of this file's claim on the plan. These rows are not
 * one click away when the Changes panel is the open one: they ARE the thing being read, and the +/− beside each
 * of them is worked out from exactly this read (useCodeStats), so a band that put them behind the board's cards
 * put the numbers on the screen in front of the user behind reads for screens that are not. It did: on the
 * workspace route these sat in `near` after the focused conversation's whole review — up to a hundred and twenty
 * rows of it, in the same band, filed under different keys — so a panel opened beside a working agent showed
 * provisional counts for minutes.
 *
 * Standing in the workspace with another panel open they are one click away and belong beside the board's cards;
 * standing anywhere else they are still the primary work surface — the plan's whole point is that they stay
 * warm — but the board's cards are nearer, and a band is a claim about distance rather than about importance. */
const band = (): WarmBand => {
    if (router.currentRoute.value.name !== `workspace`) {
        return `work`;
    }
    const layout = useLayout();
    // Collapsed counts as closed: the aside is not drawn at all, so the rows are a click on the mode switch away
    // rather than under the reader's eye (WorkspaceDesktop's `sidebarOpen`).
    return layout.sidebarPanel.value === `changes` && !layout.sidebarCollapsed.value ? `now` : `near`;
};

export const changesWarmSource = (): readonly WarmTask[] => {
    const list = warmQuery(`changes:list`, `work`, { queryKey: changesKey(), queryFn: fetchChanges });
    const held = queryClient.getQueryData<GitChangesResponse>(changesKey());
    if (held === undefined) {
        // Nothing to walk yet — the list itself is the only wish, and the rows follow on the beat after it lands.
        return [list];
    }
    const rows = warmRows(held.repos ?? []).map((row) =>
        warmQuery(`diff:${row.repo}:${row.side}:${row.path}`, band(), fileDiffQuery(row.repo, row.path, row.side)),
    );
    return [list, ...rows];
};

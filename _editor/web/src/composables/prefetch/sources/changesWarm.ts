import type { GitChangesResponse } from "@intentic-app/api-contract";
import { router } from "../../../router";
import { queryClient } from "../../queryPersistence";
import { changesKey, fetchChanges, fileDiff, fileDiffKey } from "../../workspace/useChanges";
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

/* THE ROUTE IS THE ONLY THING THAT SAYS HOW CLOSE THE READER IS. Standing in the workspace, these rows are one
 * click away and belong beside the agent board's cards; standing anywhere else they are still the primary work
 * surface — the plan's whole point is that they stay warm — but the board's cards are nearer, and a band is a
 * claim about distance rather than about importance. */
const band = (): WarmBand => (router.currentRoute.value.name === `workspace` ? `near` : `work`);

export const changesWarmSource = (): readonly WarmTask[] => {
    const list = warmQuery(`changes:list`, `work`, changesKey(), fetchChanges);
    const held = queryClient.getQueryData<GitChangesResponse>(changesKey());
    if (held === undefined) {
        // Nothing to walk yet — the list itself is the only wish, and the rows follow on the beat after it lands.
        return [list];
    }
    const rows = warmRows(held.repos ?? []).map((row) =>
        warmQuery(`diff:${row.repo}:${row.side}:${row.path}`, band(), fileDiffKey(row.repo, row.path, row.side), () =>
            fileDiff(row.repo, row.path, row.side),
        ),
    );
    return [list, ...rows];
};

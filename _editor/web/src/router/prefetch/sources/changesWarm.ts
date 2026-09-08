import type { GitChangesResponse } from "@intentic/api-contract";
import { router } from "../..";
import { useLayout } from "../../../shell/window/useLayout";
import { queryClient } from "../../../lib/queryPersistence";
import { changesKey, fetchChanges, fileDiffQuery } from "../../../features/workspace/changes/useChanges";
import type { WarmBand, WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";
import { warmRows } from "./warmRows";

// Warms the workspace review's change list and its rows' diffs, in the panel's own order: conflicts,
// staged, unstaged, repo by repo. Read from the query cache rather than observed — the Workspace badge
// already holds an observer, so this only has to cover a cold cache.

// On screen (Changes panel open) the rows are `now`; everywhere else `near`, never lower. A turn ending
// invalidates the whole review at once (list and diffs share changesKey), so it needs reading back early.
const band = (): WarmBand => {
    if (router.currentRoute.value.name !== `workspace`) {
        return `near`;
    }
    const layout = useLayout();
    // Collapsed counts as closed: the aside isn't drawn, so the rows aren't under the reader's eye.
    return layout.sidebarPanel.value === `changes` && !layout.sidebarCollapsed.value ? `now` : `near`;
};

export const changesWarmSource = (): readonly WarmTask[] => {
    // The list shares its rows' band; a list warmed below its rows would never come first.
    const list = warmQuery(`changes:list`, band(), { queryKey: changesKey(), queryFn: fetchChanges });
    const held = queryClient.getQueryData<GitChangesResponse>(changesKey());
    if (held === undefined) {
        // Nothing to walk yet: the list is the only wish until it lands.
        return [list];
    }
    const rows = warmRows(held.repos ?? []).map((row) =>
        warmQuery(`diff:${row.repo}:${row.side}:${row.path}`, band(), fileDiffQuery(row.repo, row.path, row.side)),
    );
    return [list, ...rows];
};

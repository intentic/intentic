import { computed, type ComputedRef } from "vue";
import { here, page } from "../../lib/routes/links";
import { usePanels } from "../extensions/usePanels";
import { RUN_VIEW_ID, sectionReachable } from "../../workbench/views/registry";

// Where a repository is run from: the Run view (features/run/RunView.vue), picked on that repository when one is named.
// What the Workspace's row and toolbar ▷ and a live app's "Run on a computer…" open, so where a run starts never depends
// on which of them is on screen.
export const runViewLink = (repo?: string): string => here(page.extension(RUN_VIEW_ID, undefined, repo === undefined ? {} : { query: { repo } }));

// Whether there is a Run view to send the reader to: a repository for it to run (its tile's own detect,
// core-views/coreViews.ts) and a reader it lets in.
export const useRunReachable = (): ComputedRef<boolean> => {
    const { panels } = usePanels();
    return computed(() => panels.value.length > 0 && sectionReachable(runViewLink()));
};

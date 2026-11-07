import { here, page } from "../../lib/routes/links";
import { RUN_VIEW_ID } from "../../workbench/views/registry";

// Where a repository is run from: the Run view (features/run/RunView.vue), picked on that repository when one is named.
// What the Workspace's row and toolbar ▷ and a live app's "Run on a computer…" open, so where a run starts never depends
// on which of them is on screen.
export const runViewLink = (repo?: string): string => here(page.extension(RUN_VIEW_ID, undefined, repo === undefined ? {} : { query: { repo } }));

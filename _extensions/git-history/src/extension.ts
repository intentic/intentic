import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host.js";
import { repoAt } from "./repos.js";

// Registers git history as a document, not a view: read in place beside a repo's files, the same grain documentation's
// architecture pages use. Wide, so it's an editor tab, mirroring VSCode's separate SCM list and Git Graph tab.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);

    context.subscriptions.push(
        api.documents.register({
            id: `git-history`,
            // Every repository row, from the host's live repo facts (a ref, no poll), so the icon appears the moment a
            // repo is cloned. `sitemap` matches the tab's own icon and differs from its row neighbours.
            detect: (path) => (repoAt(path) === undefined ? undefined : { icon: `sitemap`, tooltip: `Open git history`, title: `History` }),
            view: async () => (await import(`./GitHistoryTab.vue`)).default,
        }),
    );

    // The workspace root has no tree row, since the tree lists what's inside it; yet every landed branch is a commit on
    // it, so the palette is its only way in.
    context.subscriptions.push(api.commands.register(`git-history.open`, () => api.documents.open(`git-history`, ``)));
};

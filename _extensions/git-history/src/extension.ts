import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host.js";

// Registers git history as a repository's own tab in the management panel, beside Docs and Health, rather than a
// second icon on its tree row. Wide, so it fills an editor tab, mirroring VSCode's separate SCM list and Git Graph tab.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);

    context.subscriptions.push(
        api.views.register({
            id: `git-history-repo`,
            label: `Git`,
            surface: `directory`,
            // Auxiliary: every repo has a history, so claiming them would starve views that only serve unclaimed repos.
            auxiliary: true,
            // From the host's live repo facts (a ref, no poll), so the tab is there the moment a repo is cloned.
            detect: (repos) => repos.map((repo) => ({ key: repo.repo, title: `Git`, repo: repo.repo, props: { path: repo.repo } })),
            view: async () => (await import(`./GitHistoryTab.vue`)).default,
        }),
    );

    // The workspace root has no tree row, and so no management panel; yet every landed branch is a commit on it, so it
    // keeps a document of its own and the palette is its only way in.
    context.subscriptions.push(
        api.documents.register({
            id: `git-history`,
            detect: (path) => (path === `` ? { icon: `sitemap`, tooltip: `Open git history`, title: `History` } : undefined),
            view: async () => (await import(`./GitHistoryTab.vue`)).default,
        }),
    );
    context.subscriptions.push(api.commands.register(`git-history.open`, () => api.documents.open(`git-history`, ``)));
};

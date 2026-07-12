import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-preview activation: bind the host handle, then register the fallback directory view — a raw dev-server
 * iframe for any runnable repo (repo.hasPanel) that no first-party extension already serves. `fallback: true`
 * means the registry drops its activation for a repo another view claims. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `preview`,
            label: `Preview`,
            surface: `directory`,
            fallback: true,
            detect: (repos) => repos.filter((repo) => repo.hasPanel).map((repo) => ({ key: repo.repo, title: repo.repo, repo: repo.repo })),
            view: async () => (await import(`./PanelView.vue`)).default,
        }),
    );
};

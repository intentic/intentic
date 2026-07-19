import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-preview activation: bind the host handle, then register the fallback directory view — a raw dev-server
 * iframe for any runnable repo (repo.hasPanel) that no first-party extension already serves (`fallback: true`
 * means the registry drops its activation for a repo another view claims) — and the always-present "Ports"
 * rail view, the generic forward surface for ports the panel machinery never assigned. */
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
        api.views.register({
            id: `ports`,
            label: `Ports`,
            surface: `rail`,
            detect: () => [{ key: `ports`, title: `Ports`, icon: `globe` }],
            view: async () => (await import(`./PortsView.vue`)).default,
        }),
    );
};

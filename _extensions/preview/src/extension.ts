import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-preview activation: bind the host handle, then register the fallback directory view — a raw dev-server
 * iframe for any runnable repo (repo.hasPanel) that no first-party extension already serves (`fallback: true`
 * means the registry drops its activation for a repo another view claims) — and the always-present "Ports"
 * view, the generic forward surface for ports the panel machinery never assigned.
 *
 * Ports is a SANDBOX HUB tab (/sandbox/ports), not a rail tile: what is listening inside the box and what the
 * tunnel exposes is a fact about the box, alongside Status and Access. The everyday path to a dev server is
 * already elsewhere — Ctrl+clicking the localhost URL a terminal printed forwards and opens it — so this view
 * is the fallback for ports nothing linked (published containers, agent-started servers) and the place to see
 * and revoke what is currently public. The rail carries only the EXPOSURE signal: an indicator that appears
 * exactly while a port is forwarded, the way the VPN shield does. */
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
            surface: `sandbox`,
            detect: () => [{ key: `ports`, title: `Ports`, icon: `globe` }],
            view: async () => (await import(`./PortsView.vue`)).default,
        }),
    );
};

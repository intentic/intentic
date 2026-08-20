import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-preview activation: bind the host handle, then register the two exposure surfaces, "Ports" and
 * "Public". LOOKING at a running app is not registered here: that is the shell's own Preview area (a rail
 * tile whose panel pops out like the chat), which reads the same /panels, /apps and /public routes; this
 * extension used to carry a per-repo dev-server iframe as a fallback directory view, and one preview surface
 * is enough.
 *
 * Ports is a SANDBOX HUB tab (/sandbox/ports), not a rail tile: what is listening inside the box and what the
 * tunnel exposes is a fact about the box, alongside Status and Access. The everyday path to a dev server is
 * already elsewhere. Ctrl+clicking the localhost URL a terminal printed forwards and opens it, so this view
 * is the fallback for ports nothing linked (published containers, agent-started servers) and the place to see
 * and revoke what is currently public. The rail carries only the EXPOSURE signal: an indicator that appears
 * exactly while a port is forwarded, the way the VPN shield does.
 *
 * Public sits beside it for the same reason and answers the other half of the same question. Ports is what the
 * box exposes while something is RUNNING; Public is what it exposes with nothing running at all, the files in
 * the workspace's `public/` folder. Both are "what can the outside reach", which is why neither is a rail tile
 * and both are facts about the box. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `ports`,
            label: `Ports`,
            surface: `sandbox`,
            detect: () => [{ key: `ports`, title: `Ports`, icon: `globe` }],
            view: async () => (await import(`./PortsView.vue`)).default,
        }),
        api.views.register({
            id: `public`,
            label: `Public`,
            surface: `sandbox`,
            detect: () => [{ key: `public`, title: `Public`, icon: `cloud-upload` }],
            view: async () => (await import(`./PublicView.vue`)).default,
        }),
    );
};

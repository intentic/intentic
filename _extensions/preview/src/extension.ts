import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

// Binds the host, then registers Ports and Public as sandbox-hub tabs, facts about the box rather than rail tiles.
// Ports covers what's exposed while something runs; Public covers `public/` with nothing running at all.
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

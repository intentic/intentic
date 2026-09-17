import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";
import { t } from "./i18n.js";

// Binds the host, then registers Ports and Public as sandbox-hub tabs, facts about the box rather than rail tiles.
// Ports covers what's exposed while something runs; Public covers `public/` with nothing running at all.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `ports`,
            label: t(`extension.ports`),
            surface: `sandbox`,
            detect: () => [{ key: `ports`, title: t(`extension.ports`), icon: `globe` }],
            view: async () => (await import(`./PortsView.vue`)).default,
        }),
        api.views.register({
            id: `public`,
            label: t(`extension.public`),
            surface: `sandbox`,
            detect: () => [{ key: `public`, title: t(`extension.public`), icon: `cloud-upload` }],
            view: async () => (await import(`./PublicView.vue`)).default,
        }),
    );
};

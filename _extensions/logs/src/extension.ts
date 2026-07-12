import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-logs activation: bind the host handle, then register the always-present "Logs" rail view. The daemon
 * records terminal captures, intentic runs and its own log unconditionally, so the view detects unconditionally
 * (one activation, no repo/capability evidence needed). */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `logs`,
            label: `Logs`,
            surface: `rail`,
            detect: () => [{ key: `logs`, title: `Logs`, icon: `file` }],
            view: async () => (await import(`./LogsView.vue`)).default,
        }),
    );
};

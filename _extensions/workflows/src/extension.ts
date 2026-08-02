import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-workflows activation: bind the host handle, then register the "Workflows" rail view. Like automations,
 * workflows are native to every sandbox (no capability to enable), so the view detects unconditionally. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `workflows`,
            label: `Workflows`,
            surface: `rail`,
            detect: () => [{ key: `workflows`, title: `Workflows`, icon: `sitemap` }],
            view: async () => (await import(`./WorkflowsView.vue`)).default,
        }),
    );
};

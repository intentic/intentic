import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

// Binds the host handle and registers Knowledge as a sandbox section (beside Memory), not a rail tile: a knowledge base
// is somewhere you go deliberately, not somewhere that has something to announce. Detects unconditionally; an empty
// state explaining how to fill it beats an absent tab.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `knowledge`,
            label: `Knowledge`,
            surface: `sandbox`,
            detect: () => [{ key: `knowledge`, title: `Knowledge`, icon: `sitemap` }],
            view: async () => (await import(`./KnowledgeView.vue`)).default,
        }),
    );
};

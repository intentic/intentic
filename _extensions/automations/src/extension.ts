import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

// Binds the host handle and registers the Automations rail view. Detection is unconditional: automations need no
// capability to enable, so the area always exists. No badge here: the Approvals page already carries the
// requireApproval count.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `automations`,
            label: `Automations`,
            surface: `rail`,
            detect: () => [{ key: `automations`, title: `Automations`, icon: `clock` }],
            view: async () => (await import(`./AutomationsView.vue`)).default,
        }),
    );
};

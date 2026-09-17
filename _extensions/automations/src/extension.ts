import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";
import { t } from "./i18n.js";

// Binds the host handle and registers the Automations rail view. Detection is unconditional: automations need no
// capability to enable, so the area always exists. No badge here: the Approvals page already carries the
// requireApproval count.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `automations`,
            label: t(`extension.automations`),
            surface: `rail`,
            detect: () => [{ key: `automations`, title: t(`extension.automations`), icon: `clock` }],
            view: async () => (await import(`./AutomationsView.vue`)).default,
        }),
    );
};

import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-automations activation: bind the host handle, then register the "Automations" rail view. Automations are
 * native to every sandbox (no capability to enable), so the view detects unconditionally, a permanent rail
 * tile, as it was a fixed shell tile before the migration. */
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

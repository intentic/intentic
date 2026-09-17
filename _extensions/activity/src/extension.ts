import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";
import { t } from "./i18n";

// Binds the host, then registers the Activity view; must not depend on the privileged capability inventory, or a member
// could read /activity with no route to it. A sandbox section, not a rail tile: never badges, since an always-moving
// feed would light the rail permanently for nothing.

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `activity`,
            label: t(`title`),
            surface: `sandbox`,
            detect: () => [{ key: `activity`, title: t(`title`), icon: `wave-pulse` }],
            view: async () => (await import(`./ActivityView.vue`)).default,
        }),
    );
};

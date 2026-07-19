import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-activity activation: bind the host handle, then register the "Activity" rail view. It is
 * capability-driven, not repo-driven — the audit feed surfaces when any monitored provider (discord so far) is
 * connected, detected purely from the public capability facts. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `activity`,
            label: `Activity`,
            surface: `rail`,
            detect: (_repos, capabilities) =>
                capabilities.some((capability) => capability.kind === `cli` && capability.config[`provider`] === `discord`)
                    ? [{ key: `activity`, title: `Activity`, icon: `wave-pulse` }]
                    : [],
            view: async () => (await import(`./ActivityView.vue`)).default,
        }),
    );
};

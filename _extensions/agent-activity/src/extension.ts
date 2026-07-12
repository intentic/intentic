import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-agent-activity activation: bind the host handle, then register the "Agent activity" rail view. It is
 * capability-driven, not repo-driven — the audit feed surfaces when any monitored provider (discord so far) is
 * connected, detected purely from the public capability facts. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `agent-activity`,
            label: `Agent activity`,
            surface: `rail`,
            detect: (_repos, capabilities) =>
                capabilities.some((capability) => capability.kind === `cli` && capability.config[`provider`] === `discord`)
                    ? [{ key: `activity`, title: `Agent activity`, icon: `wave-pulse` }]
                    : [],
            view: async () => (await import(`./AgentActivityView.vue`)).default,
        }),
    );
};

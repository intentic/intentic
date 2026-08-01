import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-activity activation: bind the host handle, then register the "Activity" rail view. It is
 * capability-driven, not repo-driven — the audit feed surfaces when a monitored provider is connected,
 * detected purely from the public capability facts. */

// The providers whose traffic the daemon actually audits: a gateway pushes their connection health, and the
// outbound sniffer parses their skill's curl calls. A connector with neither (github, sentry) would give the
// rail an empty feed, which is why this is a list and not "any cli capability".
const MONITORED = new Set([`discord`, `slack`]);

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `activity`,
            label: `Activity`,
            surface: `rail`,
            detect: (_repos, capabilities) =>
                capabilities.some((capability) => capability.kind === `cli` && MONITORED.has(String(capability.config[`provider`])))
                    ? [{ key: `activity`, title: `Activity`, icon: `wave-pulse` }]
                    : [],
            view: async () => (await import(`./ActivityView.vue`)).default,
        }),
    );
};

import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-activity activation: bind the host handle, then register the "Activity" view. It is capability-driven,
 * not repo-driven — the audit feed surfaces when a monitored provider is connected, detected purely from the
 * public capability facts.
 *
 * A SANDBOX SECTION, NOT A RAIL TILE — the same move logs made, and Activity is the closer relative of the two:
 * it is the record of what reached this box and what it did about it, which is the sandbox hub's own subject.
 * It never badges and never will, because what it holds is a LEVEL and not an edge — a feed that is always
 * moving would light the rail permanently, and a tile that is always lit says nothing. The things in it that
 * genuinely want you are already surfaced where they can be acted on: a failed automation run is on its
 * automation's row, and a wake held for approval is a card on the fleet board. This is where you come to read
 * the whole record afterwards, on your own initiative — which is a hub section's job, not a rail seat's. */

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
            surface: `sandbox`,
            detect: (_repos, capabilities) =>
                capabilities.some((capability) => capability.kind === `cli` && MONITORED.has(String(capability.config[`provider`])))
                    ? [{ key: `activity`, title: `Activity`, icon: `wave-pulse` }]
                    : [],
            view: async () => (await import(`./ActivityView.vue`)).default,
        }),
    );
};

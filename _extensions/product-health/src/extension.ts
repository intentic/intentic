import type { CapabilityFacts, ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";
import { t } from "./i18n.js";
import { badge, snapshotQuery, startBadge } from "./useHealth";

// A PostHog connection on the Capabilities page: the card this extension contributes.
const postHogConnected = (capabilities: readonly CapabilityFacts[]): boolean =>
    capabilities.some((capability) => capability.kind === `cli` && capability.config[`provider`] === `posthog`);

// Binds the host, starts the badge poll, then registers the Product health rail view. Capability-driven, as Pipelines
// and Deployments are: the tile appears once PostHog is connected, one tile however many projects are, since the
// backend reads every connection and the view names a row's connection when there is more than one.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    // Older sandboxes still supply the PostHog card through Connectors. The view needs its own backend.
    if (api.backend.available !== true) {
        return;
    }
    bindHost(api);
    // Before the registration, so a tile can badge on its first render rather than a minute later.
    context.subscriptions.push(startBadge());
    context.subscriptions.push(
        api.views.register({
            id: `product-health`,
            label: t(`title`),
            surface: `rail`,
            // `usage`, a chart: what the product's analytics say. `wave-pulse` is Activity's, and no rail tile wears this one.
            detect: (_repos, capabilities) => (postHogConnected(capabilities) ? [{ key: `product-health`, title: t(`title`), icon: `usage` }] : []),
            // What PostHog's findings owe the reader (owed.ts); viewing the board does not clear it.
            badge: () => badge.value,
            warm: () => [snapshotQuery()],
            view: async () => (await import(`./ProductHealthView.vue`)).default,
        }),
    );
};

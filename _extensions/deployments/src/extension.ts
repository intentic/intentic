import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";
import { deployBadge, startDeployAttention, watchConnections } from "./attention";

// Binds the host, starts the badge poll, then registers the Deployments rail view. Capability-driven, not repo-driven
// (mirrors ext-pipelines): an owner who only connects Komodo, with no intent or desired-state repo, still gets a tile.
// One tile per connection, since two Komodos are two production estates and must not share a badge.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before the registration, so a tile can badge on its first render rather than a minute later.
    context.subscriptions.push(startDeployAttention());
    context.subscriptions.push(
        api.views.register({
            id: `deployments`,
            label: `Deployments`,
            surface: `rail`,
            detect: (_repos, capabilities) => {
                const connections = capabilities
                    .filter((capability) => capability.kind === `cli` && capability.config[`provider`] === `komodo`)
                    .map((capability) => capability.id);
                // detect() runs every facts poll, the only place that knows which Komodos are connected right now.
                watchConnections(connections);
                return connections.map((capability) => ({
                    key: capability,
                    // Capability id is the owner's instance name; a single default connection just reads "Deployments".
                    title: connections.length === 1 ? `Deployments` : `Deployments · ${capability}`,
                    icon: `box`,
                    props: { capability },
                }));
            },
            // Unacknowledged incidents only: reads Komodo's alert log rather than counting what's currently down.
            badge: (activation) => deployBadge(activation.key),
            view: async () => (await import(`./DeploymentsView.vue`)).default,
        }),
    );
};

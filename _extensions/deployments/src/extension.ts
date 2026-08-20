import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";
import { deployBadge, startDeployAttention, watchConnections } from "./attention";

/* ext-deployments activation: bind the host handle, start the badge's background poll, then register the
 * "Deployments" rail view.
 *
 * Capability-driven, not repo-driven, the ext-pipelines shape, and for the same reason. The two existing
 * infra surfaces (Infrastructure, Live status) are gated on the intent and desired-state repos, so someone who
 * simply connects a Komodo they already run gets nothing in the rail. Gating on the connection fixes that, and
 * ONE TILE PER CONNECTION is right rather than one for the extension: two Komodos are two production estates,
 * and looking at staging must not silence the other.
 */
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
                // detect() runs on every facts poll, which makes it the one place that knows which Komodos are
                // connected right now, so it is also what tells the badge poller what to watch.
                watchConnections(connections);
                return connections.map((capability) => ({
                    key: capability,
                    // The capability id names the instance the owner chose ("production", "staging"). With a
                    // single default-named connection that reads as plain "Deployments", which is what one
                    // Komodo should look like.
                    title: connections.length === 1 ? `Deployments` : `Deployments · ${capability}`,
                    icon: `box`,
                    props: { capability },
                }));
            },
            // Unacknowledged incidents only, see incidents.ts for why this reads Komodo's alert log rather
            // than counting what is currently down.
            badge: (activation) => deployBadge(activation.key),
            view: async () => (await import(`./DeploymentsView.vue`)).default,
        }),
    );
};

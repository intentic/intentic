import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { ciBadge, startCiAttention } from "./ciAttention";
import { bindHost } from "./host";

/* ext-pipelines activation: bind the host handle, start the badge's background poll, then register the
 * "Pipelines" rail view. Capability-driven, not repo-driven — the tile surfaces when a github/gitlab connector
 * is on, detected purely from the public capability facts (which repos actually map to CI projects is the
 * daemon's answer, rendered inside the view). */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before the registration, so the tile can badge on its first render rather than a minute later.
    context.subscriptions.push(startCiAttention());
    context.subscriptions.push(
        api.views.register({
            id: `pipelines`,
            label: `Pipelines`,
            surface: `rail`,
            detect: (_repos, capabilities) =>
                capabilities.some(
                    (capability) =>
                        capability.kind === `cli` && (capability.config[`provider`] === `github` || capability.config[`provider`] === `gitlab`),
                )
                    ? /* `bolt`, not `sitemap`. A CI pipeline IS a job graph, so `sitemap` was the apt glyph — but
                       * Workflows is a fan-out of agents and has the better claim on a tree, and two tiles sharing
                       * a silhouette in a 44px column is worse than either being slightly less apt (the argument
                       * ext-maintenance already made against `list-check`). A bolt says "this fires on its own and
                       * either lands or doesn't", which is the whole of what the tile reports. */
                      [{ key: `pipelines`, title: `Pipelines`, icon: `bolt` }]
                    : [],
            // Unacknowledged breakages only — see ciStreaks.ts for why this counts streaks and not failures.
            badge: () => ciBadge(),
            view: async () => (await import(`./PipelinesView.vue`)).default,
        }),
    );
};

import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { ciBadge, startCiAttention } from "./ciAttention";
import { ciRunsQuery } from "./ciRunsQuery";
import { bindHost } from "./host";

// Binds the host, starts the badge poll, then registers the Pipelines rail view; shown when a github/gitlab capability
// is present, not tied to specific repos.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Starts before the view registers, so the first render already has a badge.
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
                    ? /* `bolt`, not `sitemap`. A CI pipeline IS a job graph, so `sitemap` was the apt glyph, but
                       * Workflows is a fan-out of agents and has the better claim on a tree, and two tiles sharing
                       * a silhouette in a 44px column is worse than either being slightly less apt (the argument
                       * ext-maintenance already made against `list-check`). A bolt says "this fires on its own and
                       * either lands or doesn't", which is the whole of what the tile reports. */
                      [{ key: `pipelines`, title: `Pipelines`, icon: `bolt` }]
                    : [],
            // Counts branches whose last commit is red; viewing the board does not clear it.
            badge: () => ciBadge(),
            // Board's initial read, sharing the entry usePipelines reads and the badge fills; scheduled at low
            // priority.
            warm: () => [ciRunsQuery()],
            view: async () => (await import(`./PipelinesView.vue`)).default,
        }),
    );
};

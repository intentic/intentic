import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { acceptanceBadge, startAcceptanceAttention } from "./attention";
import { bindHost } from "./host";

/* ext-acceptance activation: bind the host handle, start the badge's background poll, then register the
 * "Acceptance" rail view.
 *
 * ONE TILE, NOT ONE PER REPO. A user story is a promise about the product, and a product is rarely one
 * repository, testing "sign in" may mean the web app and the API in the same run. So the area is workspace-wide
 * and the repo is a dimension INSIDE it (a story's home, a run's target URL), not the thing that addresses it.
 *
 * ACTIVATES ON `hasPanel` TOO, not on `userStories` alone. This view is where stories are WRITTEN, so gating it
 * on stories already existing would mean a workspace that has none can never reach the surface that creates the
 * first one. "There is an app here that could be tested" is the honest evidence for offering the area. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before the registration, so the tile can badge on its first render rather than a minute later.
    context.subscriptions.push(startAcceptanceAttention());
    context.subscriptions.push(
        api.views.register({
            id: `acceptance`,
            label: `Acceptance`,
            surface: `rail`,
            detect: (repos) =>
                repos.some((repo) => repo.userStories || repo.hasPanel) ? [{ key: `acceptance`, title: `Acceptance`, icon: `list-check` }] : [],
            // Failed or blocked stories from a run you haven't acknowledged, see attention.ts for why that is
            // the bar rather than a count of everything that ever failed.
            badge: () => acceptanceBadge(),
            view: async () => (await import(`./AcceptanceView.vue`)).default,
        }),
    );
};

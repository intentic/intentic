import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { acceptanceBadge, startAcceptanceAttention } from "./attention";
import { bindHost } from "./host";

// Activation: binds the host, starts the badge's background poll, then registers the Acceptance rail view. One tile,
// not one per repo, since a promise like signing in can span the web app and the API in one run. Activates on
// `hasPanel` too, not just `userStories`, since this view is where the first story gets written.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before registration, so the tile can badge on its first render rather than a minute later.
    context.subscriptions.push(startAcceptanceAttention());
    context.subscriptions.push(
        api.views.register({
            id: `acceptance`,
            label: `Acceptance`,
            surface: `rail`,
            detect: (repos) =>
                repos.some((repo) => repo.userStories || repo.hasPanel) ? [{ key: `acceptance`, title: `Acceptance`, icon: `list-check` }] : [],
            // Failed or blocked stories from an unacknowledged run; see attention.ts for why that's the bar, not a
            // count of everything that ever failed.
            badge: () => acceptanceBadge(),
            view: async () => (await import(`./AcceptanceView.vue`)).default,
        }),
    );
};

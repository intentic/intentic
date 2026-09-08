import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { startRunAttention, workflowsBadge } from "./attention";
import { bindHost } from "./host";
import { workflowRunsQuery } from "./runsQuery";

// Binds the host, starts the badge's background poll, then registers the Workflows rail view. Detects unconditionally,
// since workflows are native to every sandbox with no capability to enable; whether the rail actually seats it is
// decided by the app's seat table from the badge below.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Pushed before the view registration, so an overnight run seats the tile on first render.
    context.subscriptions.push(startRunAttention());
    context.subscriptions.push(
        api.views.register({
            id: `workflows`,
            label: `Workflows`,
            surface: `rail`,
            detect: () => [{ key: `workflows`, title: `Workflows`, icon: `sitemap` }],
            // Runs in flight; not a count of saved designs or of everything that ever failed.
            badge: () => workflowsBadge(),
            // Same query the badge already reads and the page opens on, warmed so a mid-run arrival skips the spinner.
            warm: () => [workflowRunsQuery()],
            view: async () => (await import(`./WorkflowsView.vue`)).default,
        }),
    );
};

import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { startRunAttention, workflowsBadge } from "./attention";
import { bindHost } from "./host";
import { workflowRunsQuery } from "./runsQuery";

/* ext-workflows activation: bind the host handle, start the badge's background poll, then register the
 * "Workflows" rail view.
 *
 * IT DETECTS UNCONDITIONALLY, like automations, and means by that what automations does: workflows are native to
 * every sandbox (no capability to enable), so the AREA exists everywhere, which is what makes `/ext/workflows`
 * resolve and puts the row in the More list, the mobile menu and the palette. Whether the rail spends a SEAT on
 * it is the app's question, answered by its seat table (core-views/registry.ts) from the badge below: a designer
 * you open when you want to build something does not hold one of nine seats between visits. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before the registration, so a run still going from yesterday seats the tile on the first render.
    context.subscriptions.push(startRunAttention());
    context.subscriptions.push(
        api.views.register({
            id: `workflows`,
            label: `Workflows`,
            surface: `rail`,
            detect: () => [{ key: `workflows`, title: `Workflows`, icon: `sitemap` }],
            // Runs in flight, see attention.ts for why that is the bar rather than a count of saved designs or
            // of everything that ever failed.
            badge: () => workflowsBadge(),
            // The ledger the page opens on, which is also the entry the badge fills: warming it costs nothing
            // the tile was not already reading, and someone arriving mid-run wants the graph, not a spinner.
            warm: () => [workflowRunsQuery()],
            view: async () => (await import(`./WorkflowsView.vue`)).default,
        }),
    );
};

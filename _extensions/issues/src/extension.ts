import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { bindHost, host } from "./host";
import { issuesQuery, owedOf } from "./useIssues";

// Binds the host handle and registers the Issues rail view. Detection is unconditional (the area always exists); the
// rail seat depends on the badge, which shares its HostQuery with the view so first paint matches. Poll is a 10-minute
// backstop; the `.intentic/records/issues/` file binding pushes on every real change.

const { state: badge, start: startIssuesAttention } = sandboxPoll<ViewBadge | undefined>({
    host,
    everyMs: 10 * 60_000,
    initial: () => undefined,
    read: async (api) => {
        const { owed, broken } = owedOf(await api.sandbox.fetch(issuesQuery()));
        return owed === 0
            ? undefined
            : {
                  count: owed,
                  // Phrased to follow the tile name: "Issues · 3 waiting on you".
                  tooltip: `${owed} waiting on you`,
                  // `danger` only for something wrong (a fix that didn't hold, or an unreadable file), not a fresh
                  // crash report.
                  tone: broken > 0 ? `danger` : `info`,
              };
    },
});

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(startIssuesAttention());
    context.subscriptions.push(
        api.views.register({
            id: `issues`,
            label: `Issues`,
            surface: `rail`,
            detect: () => [{ key: `issues`, title: `Issues`, icon: `exclamation-triangle` }],
            badge: () => badge.value,
            view: async () => (await import(`./IssuesView.vue`)).default,
        }),
    );
};

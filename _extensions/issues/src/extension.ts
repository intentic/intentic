import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { bindHost, host } from "./host";
import { issuesQuery, owedOf } from "./useIssues";

/* ext-issues activation: bind the host handle, then register the "Issues" rail view.
 *
 * UNCONDITIONAL DETECT, SEATED BY THE BADGE, the shape ext-approvals settles: the AREA exists on every sandbox (so
 * `/ext/issues` resolves, and Issues is in the More list, the mobile menu and the palette), while the rail SEAT
 * is decided by the badge below. A workspace whose users have never hit a bug should not carry a tile all day
 * for an empty inbox, and one whose checkout is throwing should not have to go looking for it.
 *
 * THE BADGE READS FROM MODULE STATE, not from the view: a count that only updated while somebody was already
 * reading the inbox could never tell them anything, and now could never seat the tile either. The read and the
 * view name the SAME HostQuery, so the badge's answer is also the view's first paint, and the manifest's
 * `.intentic/records/issues/` file binding is what makes both move the moment a report lands.
 *
 * TEN MINUTES, NOT ONE, and the file binding is why: every way this number changes is a write under that
 * directory (a report arriving, a turn starting, the owner filing one away), so the push is the feed and the
 * interval is only the frame nobody delivered. */

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
                  // Phrased to follow the tile's name, which the rail puts in front of it: "Issues · 3 waiting on you".
                  tooltip: `${owed} waiting on you`,
                  /* `danger` only when something is WRONG rather than merely new: a bug that was resolved and
                   * came back (a fix that did not hold), or a file the daemon could not read. A fresh crash
                   * report is the resting state of this inbox, and colouring it red cries wolf on every one. */
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

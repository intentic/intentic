import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { bindHost, host } from "./host";
import { approvalsQuery, owedOf } from "./useApprovals";
import { heldWakesQuery, waitingOf } from "./useHeldWakes";
import { t } from "./i18n.js";

// Binds the host, then registers the Approvals rail view. Detection is unconditional (it's always in More, the palette,
// and mobile Review); the rail seat itself is decided by the badge below, driven by module state rather than the view,
// so it can update and seat the tile even while closed.

// The queue's badge, sandbox-scoped so one workspace's wait isn't read as another's. Counts proposals owing a decision
// plus held automations, but not a countdown hold, which goes ahead on its own. Driven by file writes under the two
// directories; the poll interval is only a backstop for whatever the watcher missed.
// Exported whole rather than as its parts, because the view refreshes it on open: this value is read with nothing
// mounted, so a count the watcher missed can otherwise stand for ten minutes over a queue the reader is looking at
// and can see is empty.
export const approvalsAttention = sandboxPoll<ViewBadge | undefined>({
    host,
    everyMs: 10 * 60_000,
    initial: () => undefined,
    read: async (api) => {
        const [list, held] = await Promise.all([api.sandbox.fetch(approvalsQuery()), api.sandbox.fetch(heldWakesQuery())]);
        const { owed, broken } = owedOf(list);
        const count = owed + waitingOf(held).length;
        return count === 0
            ? undefined
            : {
                  count,
                  // Phrased to follow the tile's name in the rail: "Approvals · 3 waiting on you".
                  tooltip: t(`extension.waitingOn`, { count }),
                  // `danger` only when something's actually wrong; a mere proposal is the resting `info` tone.
                  tone: broken > 0 ? `danger` : `info`,
              };
    },
});

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(approvalsAttention.start());
    context.subscriptions.push(
        api.views.register({
            id: `approvals`,
            label: t(`extension.approvals`),
            surface: `rail`,
            detect: () => [{ key: `approvals`, title: t(`extension.approvals`), icon: `check-square` }],
            badge: () => approvalsAttention.state.value,
            // The two reads the badge already made, so the page opens on the queue rather than on a spinner.
            warm: () => [approvalsQuery(), heldWakesQuery()],
            view: async () => (await import(`./ApprovalsView.vue`)).default,
        }),
    );
};

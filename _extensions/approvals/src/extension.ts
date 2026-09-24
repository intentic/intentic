import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { roleAtLeast } from "@intentic/sandbox-contract";
import { bindHost, host } from "./host";
import { approvalsQuery, owedOf } from "./useApprovals";
import { heldWakesQuery, waitingOf } from "./useHeldWakes";
import { hookRequestsQuery, waitingHooksOf } from "./useHookRequests";
import { t } from "./i18n.js";

// Binds the host, then registers the Approvals rail view. Detection is unconditional (it's always in More, the palette,
// and mobile Review); the rail seat itself is decided by the badge below, driven by module state rather than the view,
// so it can update and seat the tile even while closed.

// The queue's badge, sandbox-scoped so one workspace's wait isn't read as another's. Counts proposals owing a decision,
// held automations and hook sets waiting for a yes, but not a countdown hold, which goes ahead on its own. Driven by file
// writes under the two directories; hook sets live off /work, so while the page is closed the poll alone finds them.
// Exported whole rather than as its parts, because the view refreshes it on open: this value is read with nothing
// mounted, so a count the watcher missed can otherwise stand for ten minutes over a queue the reader is looking at
// and can see is empty.
export const approvalsAttention = sandboxPoll<ViewBadge | undefined>({
    host,
    everyMs: 10 * 60_000,
    initial: () => undefined,
    read: async (api) => {
        const [list, held, hooks] = await Promise.all([
            api.sandbox.fetch(approvalsQuery()),
            api.sandbox.fetch(heldWakesQuery()),
            // Refused below maintainer, where there is no yes to give: that reader is owed nothing here. Above it, a
            // failed read fails the badge, which then keeps its last count rather than dropping the waiting hook sets.
            roleAtLeast(api.sandbox.role(), `maintainer`) ? api.sandbox.fetch(hookRequestsQuery()) : undefined,
        ]);
        const { owed, broken } = owedOf(list);
        const count = owed + waitingOf(held).length + waitingHooksOf(hooks).length;
        return count === 0
            ? undefined
            : {
                  count,
                  // Phrased to follow the tile's name in the rail: "Approvals · 3 waiting on you".
                  tooltip: t(`extension.waitingOn`, { count }),
                  // `danger` only when something's actually wrong; a mere proposal is the resting `info` tone.
                  tone: broken > 0 || hooks?.ledgerUnreadable === true ? `danger` : `info`,
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
            // The reads the badge already made, so the page opens on the queue rather than on a spinner; hook sets only for
            // a reader the daemon answers them for.
            warm: () => [approvalsQuery(), heldWakesQuery(), ...(roleAtLeast(host().sandbox.role(), `maintainer`) ? [hookRequestsQuery()] : [])],
            view: async () => (await import(`./ApprovalsView.vue`)).default,
        }),
    );
};

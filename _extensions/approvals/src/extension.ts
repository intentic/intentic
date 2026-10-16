import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { owedBadge, type QueueSnapshot } from "./owed";
import { bindHost, host } from "./host";
import { approvalsQuery } from "./useApprovals";
import { heldWakesQuery } from "./useHeldWakes";
import { hookRequestsQuery } from "./useHookRequests";
import { t } from "./i18n.js";

// Binds the host, then registers the Approvals rail view. Detection is unconditional (it's always in More and the
// palette); the tile badges what the queue owes a person (owed.ts), which is what brings it onto the rail by itself.
// 2026-09-30 to 2026-10-12 the count lived in the host's Needs you inbox instead, as one ask per decision; the inbox
// left the editor, since every other tile already badged its own wait and this one was the only place that did not.

// The queue as a person owes it, sandbox-scoped so one workspace's wait isn't read as another's. Driven by file writes
// under the two directories; hook sets live off /work, so while the page is closed the poll alone finds them. Held
// wakes are not read here: the board draws those, from its own read. Exported whole, because the view refreshes it on
// open, and a press there refreshes it after the write.
export const approvalsAttention = sandboxPoll<QueueSnapshot | undefined>({
    host,
    everyMs: 10 * 60_000,
    initial: () => undefined,
    read: async (api) => {
        // Past the host's cache: the page refreshes this after a press, and a cached answer would leave the badge up.
        const [list, hooks] = await Promise.all([
            api.sandbox.fetch({ ...approvalsQuery(), staleTime: 0 }),
            // Refused below maintainer, where there is no yes to give. Above it, a failed read fails the poll, which then
            // keeps what it last saw rather than dropping the waiting hook sets.
            roleAtLeast(api.sandbox.role(), `maintainer`) ? api.sandbox.fetch({ ...hookRequestsQuery(), staleTime: 0 }) : undefined,
        ]);
        return { list, hooks };
    },
});

// Below maintainer the queue is read-only (the daemon floors every press), so nothing here is that reader's to answer.
export const queueBadge = (): ViewBadge | undefined =>
    roleAtLeast(host().sandbox.role(), `maintainer`) ? owedBadge(approvalsAttention.state.value) : undefined;

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(approvalsAttention.start());
    context.subscriptions.push(
        api.views.register({
            id: `approvals`,
            label: t(`extension.approvals`),
            surface: `rail`,
            detect: () => [{ key: `approvals`, title: t(`extension.approvals`), icon: `check-square` }],
            badge: queueBadge,
            // The reads the badge already made, so the page opens on the queue rather than on a spinner; hook sets only
            // for a reader the daemon answers them for.
            warm: () => [approvalsQuery(), heldWakesQuery(), ...(roleAtLeast(host().sandbox.role(), `maintainer`) ? [hookRequestsQuery()] : [])],
            view: async () => (await import(`./ApprovalsView.vue`)).default,
        }),
    );
};

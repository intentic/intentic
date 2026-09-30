import type { ExtensionContext, IntenticApi, ViewAsk } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import type { ApprovalSummary } from "@intentic/sandbox-contract";
import { roleAtLeast } from "@intentic/sandbox-contract";
import { type AskPresses, asksOf, type QueueSnapshot } from "./asks";
import { bindHost, host } from "./host";
import { approvalsQuery } from "./useApprovals";
import { heldWakesQuery } from "./useHeldWakes";
import { hookRequestsQuery } from "./useHookRequests";
import { t } from "./i18n.js";

// Binds the host, then registers the Approvals rail view. Detection is unconditional (it's always in More and the
// palette); what the queue owes a person is not this tile's to count: each decision is an ask in the host's Needs you
// inbox, which carries the one count for everything waiting on a person (2026-09-30: the tile's own count and the
// inbox's were two numbers for one question, and each page sent the reader to the other).

// The queue as a person owes it, sandbox-scoped so one workspace's wait isn't read as another's. Driven by file writes
// under the two directories; hook sets live off /work, so while the page is closed the poll alone finds them. Held
// wakes are not read here: the host lists those itself, from the board's own read. Exported whole, because the view
// refreshes it on open, and a press here refreshes it after the write.
export const approvalsAttention = sandboxPoll<QueueSnapshot | undefined>({
    host,
    everyMs: 10 * 60_000,
    initial: () => undefined,
    read: async (api) => {
        // Past the host's cache: this read is what an ask's press waits on, and a cached answer would leave the ask up.
        const [list, hooks] = await Promise.all([
            api.sandbox.fetch({ ...approvalsQuery(), staleTime: 0 }),
            // Refused below maintainer, where there is no yes to give. Above it, a failed read fails the poll, which then
            // keeps what it last saw rather than dropping the waiting hook sets.
            roleAtLeast(api.sandbox.role(), `maintainer`) ? api.sandbox.fetch({ ...hookRequestsQuery(), staleTime: 0 }) : undefined,
        ]);
        return { list, hooks };
    },
});

// An ask's presses: the same writes the page makes, then a fresh read so the answered ask leaves the inbox.
const presses: AskPresses = {
    save: async (item: ApprovalSummary) => {
        await host().sandbox.rpc.approvals.upsert(item);
        approvalsAttention.refresh();
    },
    letHooksRun: async (digest) => {
        await host().sandbox.rpc.approvals.approveHooks({ digest });
        approvalsAttention.refresh();
    },
    keepHooksOff: async (digest) => {
        await host().sandbox.rpc.approvals.dismissHooks({ digest });
        approvalsAttention.refresh();
    },
};

// Below maintainer the queue is read-only (the daemon floors every press), so nothing here is that reader's to answer.
export const queueAsks = (): readonly ViewAsk[] =>
    roleAtLeast(host().sandbox.role(), `maintainer`) ? asksOf(approvalsAttention.state.value, presses) : [];

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(approvalsAttention.start());
    context.subscriptions.push(
        api.views.register({
            id: `approvals`,
            label: t(`extension.approvals`),
            surface: `rail`,
            detect: () => [{ key: `approvals`, title: t(`extension.approvals`), icon: `check-square` }],
            asks: queueAsks,
            // The reads the inbox already made, so the page opens on the queue rather than on a spinner; hook sets only for
            // a reader the daemon answers them for.
            warm: () => [approvalsQuery(), heldWakesQuery(), ...(roleAtLeast(host().sandbox.role(), `maintainer`) ? [hookRequestsQuery()] : [])],
            view: async () => (await import(`./ApprovalsView.vue`)).default,
        }),
    );
};

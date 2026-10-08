import type { BrowserSession, BrowsersList, OpenBrowserResult } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { optimisticUpdate } from "../../lib/optimistic";
import { queryClient } from "../../lib/queryPersistence";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { rpcKey } from "../../lib/queryKeys";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";

// One shared roster of the agent's browsers for the status bar's chip and the Browsers view (like terminalsQuery), so they
// can't disagree. No pending-claim half like terminals need: the daemon mints an agent browser itself, so this
// list is the client's first knowledge of it. Nothing polls; the daemon pushes the `browsers` domain on
// mint/navigate/finish (runtime-watch.ts).

// Named for the background loader (prefetch), which warms this into the same entry the tile and view read: the
// daemon's whole answer.
export const browsersKey = rpcKey(`system.browsers`);
export const fetchBrowsers = (): Promise<BrowsersList> => sandboxRpc.system.browsers();

export const useBrowsersQuery = (): { sessions: ComputedRef<BrowserSession[]>; refetch: () => Promise<unknown> } => {
    const { query } = useSandboxQuery(rpcQuery(`system.browsers`));
    // Live browsers first (what someone came for), then most recently finished, newest-first like a record.
    const sessions = computed(() =>
        (query.data.value?.sessions ?? []).toSorted(
            (left, right) => Number(right.running) - Number(left.running) || right.activityAt - left.activityAt,
        ),
    );
    return { sessions, refetch: () => query.refetch() };
};

// Drops the row from the shared list the moment the close is issued, like killTerminal, so the status bar doesn't keep
// counting a browser the user just closed. A refused close puts the row straight back; the list is re-read either way.
export const closeBrowser = async (name: string): Promise<void> => {
    try {
        await optimisticUpdate<BrowsersList, unknown>(
            browsersKey,
            (listed) => ({ ...listed, sessions: listed.sessions.filter((session) => session.name !== name) }),
            () => sandboxRpc.system.closeBrowser({ name }),
            { settle: true },
        );
    } catch (error) {
        console.error(`browser ${name}: close failed`, error);
    }
};

// A tab in the person's own window, starting the window first when it isn't running; answers where it opened, so the
// view can go there and put the new tab in front. The list is re-read rather than patched: the daemon pushes the
// window's arrival anyway, and this keeps the first frame from waiting on that push.
export const openBrowser = async (url?: string): Promise<OpenBrowserResult> => {
    const opened = await sandboxRpc.system.openBrowser(url === undefined ? {} : { url });
    void queryClient.invalidateQueries({ queryKey: browsersKey });
    return opened;
};

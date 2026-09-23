import type { BrowserSession, BrowsersList } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { queryClient } from "../../lib/queryPersistence";
import { rpcQuery } from "../sandbox/client/rpcQuery";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";
import { rpcKey } from "../../lib/queryKeys";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

// One shared roster of the agent's browsers for the rail tile and the Browsers view (like terminalsQuery), so they
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

// Drops the row from the shared list the moment the kill is issued, like removeTerminal, so the rail tile doesn't
// keep counting a browser the user just closed. Refetch restores it if the daemon disagreed.
export const closeBrowser = async (name: string): Promise<void> => {
    queryClient.setQueryData<BrowsersList>(browsersKey, (listed) =>
        listed === undefined ? undefined : { ...listed, sessions: listed.sessions.filter((session) => session.name !== name) },
    );
    try {
        await sandboxRpc.system.closeBrowser({ name });
    } catch (error) {
        console.error(`browser ${name}: close failed`, error);
    }
    await queryClient.invalidateQueries({ queryKey: browsersKey });
};

import { BrowsersListSchema, type BrowserSession } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { queryClient } from "../../lib/queryPersistence";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { BROWSERS } from "../../lib/queryKeys";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

// One shared roster of the agent's browsers for the rail tile and the Browsers view (like terminalsQuery), so they
// can't disagree. No pending-claim half like terminals need: the daemon mints an agent browser itself, so this
// list is the client's first knowledge of it. Nothing polls; the daemon pushes the `browsers` domain on
// mint/navigate/finish (runtime-watch.ts).

const QUERY_KEY = BROWSERS.of();

// Named for the background loader (prefetch), which warms this into the same entry the tile and view read.
export const browsersKey = QUERY_KEY;
export const fetchBrowsers = async (): Promise<BrowserSession[]> => BrowsersListSchema.parse(await sandboxJson(`/system/browsers`)).sessions;

export const useBrowsersQuery = (): { sessions: ComputedRef<BrowserSession[]>; refetch: () => Promise<unknown> } => {
    const { query } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchBrowsers });
    // Live browsers first (what someone came for), then most recently finished, newest-first like a record.
    const sessions = computed(() =>
        (query.data.value ?? []).toSorted((left, right) => Number(right.running) - Number(left.running) || right.activityAt - left.activityAt),
    );
    return { sessions, refetch: () => query.refetch() };
};

// Drops the row from the shared list the moment the kill is issued, like removeTerminal, so the rail tile doesn't
// keep counting a browser the user just closed. Refetch restores it if the daemon disagreed.
export const closeBrowser = async (name: string): Promise<void> => {
    queryClient.setQueryData<BrowserSession[]>(QUERY_KEY, (listed) => listed?.filter((session) => session.name !== name));
    try {
        await sandboxJson(`/system/browsers/${encodeURIComponent(name)}`, { method: `DELETE` });
    } catch (error) {
        console.error(`browser ${name}: close failed`, error);
    }
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
};

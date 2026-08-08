import { BrowsersListSchema, type BrowserSession } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The ONE roster of the agent's browsers, shared by the rail tile and the Browsers view — the same single-cache
 * shape terminalsQuery has, and for the same reason: the tile's count and the view's tab strip must not be able
 * to disagree, which they would the moment each held its own copy.
 *
 * There is no pending-claim half here, unlike the terminals. A `web-*` shell exists because THIS browser asked
 * for it, so the client knows about it before the daemon does; an agent browser is the opposite — the daemon
 * mints it from a hook on the agent's own tool call, and the client's first knowledge of it is this list. There
 * is simply no window to paper over.
 *
 * Which is also why nothing here polls: the daemon owns every one of these records, so it knows the roster
 * changed before this browser could have asked. It pushes the `browsers` domain from the same lines that mint,
 * navigate and finish a session (runtime-watch.ts), and the agent opening a page repaints the tile as it
 * happens rather than up to ten seconds later. */

const QUERY_KEY = sandboxKey(`browsers`);

const fetchBrowsers = async (): Promise<BrowserSession[]> => BrowsersListSchema.parse(await sandboxJson(`/system/browsers`)).sessions;

export const useBrowsersQuery = (): { sessions: ComputedRef<BrowserSession[]>; refetch: () => Promise<unknown> } => {
    const { query } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchBrowsers });
    // Live browsers first — a running one is what someone opening this came for — then the most recently
    // finished, because a record is read newest-first.
    const sessions = computed(() =>
        (query.data.value ?? []).toSorted((left, right) => Number(right.running) - Number(left.running) || right.activityAt - left.activityAt),
    );
    return { sessions, refetch: () => query.refetch() };
};

// Close one browser. The row drops from the shared list the moment the kill is ISSUED (the terminal strip's
// rule — see removeTerminal): without it the rail tile would keep counting a browser the user just closed for a
// tunnel round-trip, which is exactly what makes a close feel unacknowledged. The refetch puts it back if the
// daemon disagreed.
export const closeBrowser = async (name: string): Promise<void> => {
    queryClient.setQueryData<BrowserSession[]>(QUERY_KEY, (listed) => listed?.filter((session) => session.name !== name));
    try {
        await sandboxJson(`/system/browsers/${encodeURIComponent(name)}`, { method: `DELETE` });
    } catch (error) {
        console.error(`browser ${name}: close failed`, error);
    }
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
};

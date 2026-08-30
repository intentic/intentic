import { type TerminalsList, TerminalsListSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type ComputedRef } from "vue";
import { host } from "./host";

/* The daemon's tmux session list (web-* shells + panel-* dev servers + one-shot jobs), used to watch a one-shot
 * add/test session's `running` flag.
 *
 * UNPOLLED, and under the SHARED key, which is the whole point: `api.sandbox.key("terminals")` is the same
 * entry core's terminal panel and rail badge read, and the runtime table's `terminals` domain names it (contract
 * runtime-state.ts). The daemon watches its own tmux and pushes when a pane's state changes, so this list
 * refreshes on the transition itself. An extension needs no declaration of its own for that, exactly as
 * useApps.ts rides the `panels` domain.
 *
 * What it replaced: a 2.5s timer asking `/system/terminals` over the tunnel for as long as an add-apps install
 * ran, to notice a thing the daemon announces. */
export type TerminalSession = TerminalsList["sessions"][number];

/* ONE KEY, ONE FETCHER. This writes the entry core's own terminal panel and rail badge read, so it has to
 * answer the shape they parse, the whole session, not the two fields this view happens to look at. A narrower
 * fetcher here would not be a smaller payload, it would be core's list silently losing every other field the
 * next time this query refetched it. */
const fetchTerminals = async (): Promise<TerminalSession[]> => TerminalsListSchema.parse(await host().sandbox.json(`/system/terminals`)).sessions;

export function useTerminals(): { sessions: ComputedRef<TerminalSession[]> } {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`terminals`),
        queryFn: fetchTerminals,
        enabled: computed(() => api.sandbox.reachable()),
    });
    return { sessions: computed(() => query.data.value ?? []) };
}

// The one-shot read behind mount-time recovery, where the query may not have answered yet and "no data" must
// not be read as "no job running". Failures bubble to the caller.
export const listTerminals = fetchTerminals;

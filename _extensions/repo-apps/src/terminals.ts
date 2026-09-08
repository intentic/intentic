import { type TerminalsList, TerminalsListSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type ComputedRef } from "vue";
import { host } from "./host";

// Daemon's tmux session list, used here to watch a one-shot job's `running` flag. Unpolled: shares the same key as the
// entry core's own terminal panel and rail badge read, pushed by the daemon when a pane's state changes.
export type TerminalSession = TerminalsList["sessions"][number];

// One key, one fetcher: this also feeds the entry core's terminal panel and rail badge, so it must return the whole
// session shape, not just the fields this view uses, or a refetch would silently drop core's other fields.
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

// One-shot read for mount recovery: an unanswered query must not read as no job running; failures bubble up.
export const listTerminals = fetchTerminals;

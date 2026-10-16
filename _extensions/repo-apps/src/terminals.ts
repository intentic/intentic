import type { TerminalsList } from "@intentic/sandbox-contract/schemas/terminal";
import { computed, type ComputedRef } from "vue";
import { host } from "./host";

// Daemon's tmux session list, used here to watch a one-shot job's `running` flag. Unpolled: keyed by its procedure, so it
// is the entry core's own terminal panel and rail badge read, refreshed by the daemon's push when a pane's state changes.
export type TerminalSession = TerminalsList["sessions"][number];

// The one-shot list, for mount recovery below; the query stores the procedure's whole answer, which core's panel shares.
const fetchTerminals = async (): Promise<TerminalSession[]> => (await host().sandbox.rpc.system.terminals()).sessions;

export function useTerminals(): { sessions: ComputedRef<TerminalSession[]> } {
    const api = host();
    const { query } = api.sandbox.query({
        queryKey: api.sandbox.readKey(`system.terminals`),
        queryFn: () => api.sandbox.rpc.system.terminals(),
        select: (list): TerminalSession[] => list.sessions,
    });
    return { sessions: computed(() => query.data.value ?? []) };
}

// One-shot read for mount recovery: an unanswered query must not read as no job running; failures bubble up.
export const listTerminals = fetchTerminals;

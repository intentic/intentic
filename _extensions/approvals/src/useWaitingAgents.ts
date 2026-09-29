import type { AgentsList, AgentSummary } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// Agents whose running turn waits on a person's answer in its own chat: a permission, a question, a plan, a setup, a
// credential release. None of those is this queue's, which holds what an agent prepared and may not do unasked, so the
// page read "Nothing waiting" while three permission cards waited; it counts them to say where they are instead.

// No push reaches this key when a card parks, so it is re-read on a short beat while the page is open.
const REREAD_MS = 15_000;

export const waitingAgentsQuery = (): HostQuery<AgentsList> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`approvals`, `agents-waiting`),
        queryFn: (): Promise<AgentsList> => api.sandbox.rpc.agents.list(),
    };
};

// How many agents wait on an answer in their chat, as the host's own "Needs you" list gathers them.
export const waitingInChats = (agents: readonly Pick<AgentSummary, "attention">[]): number =>
    agents.filter(({ attention }) => attention.permission || attention.question || attention.plan || attention.capability || attention.credential)
        .length;

export function useWaitingAgents() {
    const api = host();
    const { data } = useQuery({
        ...waitingAgentsQuery(),
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: REREAD_MS,
    });
    return computed(() => waitingInChats(data.value?.agents ?? []));
}

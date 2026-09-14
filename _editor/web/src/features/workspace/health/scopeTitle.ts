import { computed, type ComputedRef } from "vue";
import { useAgents } from "../../agents/fleet/useAgents";
import { workspaceAgent } from "./workspaceScope";

/* WHAT TO CALL THE CONVERSATION WHOSE COPY IS ON SCREEN. */
export const useScopeTitle = (): ComputedRef<string> => {
    const { agentById } = useAgents();
    return computed(() => (workspaceAgent.value === undefined ? `` : (agentById(workspaceAgent.value)?.title ?? `an agent`)));
};

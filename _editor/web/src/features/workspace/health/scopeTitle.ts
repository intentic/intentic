import { computed, type ComputedRef, type Ref } from "vue";
import { useAgents } from "../../agents/fleet/useAgents";
import { workspaceAgent } from "../../../app/workspaceScope";

/* WHAT TO CALL THE CONVERSATION WHOSE COPY IS ON SCREEN: the Workspace's, or the one a surface reads (useViewScope). */
export const useScopeTitle = (scope: Readonly<Ref<string | undefined>> = workspaceAgent): ComputedRef<string> => {
    const { agentById } = useAgents();
    return computed(() => (scope.value === undefined ? `` : (agentById(scope.value)?.title ?? `an agent`)));
};

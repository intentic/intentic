import { computed, type ComputedRef } from "vue";
import { useAgents } from "../agents/useAgents";
import { workspaceAgent } from "./workspaceScope";

/* WHAT TO CALL THE CONVERSATION WHOSE COPY IS ON SCREEN. An agent's own name for itself is its first prompt;
 * one too new to have said anything is still worth naming as something rather than as a uuid.
 *
 * Shared by the three surfaces that name the scope, the chip in the tab row, the read-only explanation on a
 * file, and the panel a dead checkout leaves behind, so the three of them cannot end up calling the same agent
 * different things. Empty string while the view is showing the shared tree, which is the one case where none
 * of the three renders at all. */
export const useScopeTitle = (): ComputedRef<string> => {
    const { agentById } = useAgents();
    return computed(() => (workspaceAgent.value === undefined ? `` : (agentById(workspaceAgent.value)?.title ?? `an agent`)));
};

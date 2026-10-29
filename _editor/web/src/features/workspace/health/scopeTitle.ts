import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type Ref } from "vue";
import { useAgents } from "../../../models/fleet/useAgents";
import { branchLabel, type ViewScope, workspaceView } from "../../../app/workspaceScope";

/* WHAT TO CALL THE COPY ON SCREEN: the Workspace's, or the one a surface reads (useViewScope). A conversation's copy by
   its title, a branch by its name, the shared tree by nothing. */
export const useScopeTitle = (scope: Readonly<Ref<ViewScope>> = workspaceView): ComputedRef<string> => {
    const { agentById } = useAgents();
    return computed(() => {
        const { agent, branch, repo } = scope.value;
        if (branch !== undefined) {
            return branchLabel({ repo, branch });
        }
        return agent === undefined ? `` : (agentById(agent)?.title ?? t(`workspace.scopeTitle.anAgent`));
    });
};

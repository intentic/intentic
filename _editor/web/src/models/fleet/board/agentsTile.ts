import type { ViewBadge } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { projectScope } from "../../../app/projectScope";
import { useAuth } from "../../../client/auth/useAuth";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import { watchRemoteSeen } from "../fleetScope";
import { useAgents } from "../useAgents";
import { attentionOutsideProject, trackScopeInputs } from "./attentionOutside";

// What the agents tile shows, wherever it is drawn (the desktop rail's tile, the phone rail's): this sandbox's Attention
// count. What other sandboxes need is Home's to show.

// Attention cards and automation wakes held at the door.
export const agentsAttention = computed<number>(() => useAgents().attention.value);

// The badge shown by every rail tile and tab.
export const agentsBadge = computed<ViewBadge | undefined>(() => {
    const total = agentsAttention.value;
    if (total <= 0) {
        return undefined;
    }
    const needYou = t(`agents.agentsTile.needYou`, { count: total }, total);
    // The count is the sandbox's; the board shows the open project. Saying how many sit outside it is what keeps a badge
    // over a quiet board from reading as a bug.
    const outside = attentionOutsideProject.value;
    const tooltip = outside > 0 && projectScope.value !== undefined ? t(`agents.agentsTile.needYouOutside`, { owed: needYou, outside, project: projectScope.value }) : needYou;
    return { count: total, tooltip };
});

// The tile's own watch, called once from the shared shell so desktop and mobile share one subscription.
export const watchAgentsScope = (): void => {
    // Marks a chat placed in another sandbox read while it's open in front of the user, as that sandbox's own board
    // would.
    watchRemoteSeen();
    const { personas } = usePersonas();
    const { user } = useAuth();
    trackScopeInputs(
        personas,
        computed(() => user.value?.email),
    );
};

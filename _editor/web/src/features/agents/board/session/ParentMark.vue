<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { type RouteLocationNamedRaw, RouterLink } from "vue-router";
import { agentDisplayTitle } from "../../fleet/agentStatus";
import { otherFleet } from "../../fleet/fleetScope";
import { useAgents } from "../../fleet/useAgents";

/* THE CONVERSATION THAT SPAWNED THIS ONE, in OriginMark's slot and grammar: provenance, so it leads the card's body. Only a
   child standing apart from its parent wears it, one asking something of the reader or still working under a parent
   that has finished (childFold); a child riding under its parent's card says nothing of the kind, since the rail it
   hangs from already says it. Named by the parent's title, which the reader knows the work by, rather than its id. */

const props = defineProps<{ parent: string; sandboxId?: string }>();

const t = useT();
const { agentById } = useAgents();

// Read live, so a parent renamed mid-run is renamed here too; its id when no roster the board reads holds it (archived
// before the archive was first opened).
const title = computed(() => {
    const found =
        props.sandboxId === undefined
            ? agentById(props.parent)
            : otherFleet.value.find((agent) => agent.sandboxId === props.sandboxId && agent.id === props.parent);
    return found === undefined ? props.parent : agentDisplayTitle(found);
});
// Another box's parent is read from that box, which the agent's page takes from `?sandbox=` (cardSelection.agentHref).
const to = computed<RouteLocationNamedRaw>(() => {
    const location: RouteLocationNamedRaw = { name: `agent`, params: { id: props.parent } };
    if (props.sandboxId !== undefined) {
        location.query = { sandbox: props.sandboxId };
    }
    return location;
});
</script>

<template>
    <RouterLink
        :to="to"
        class="flex min-w-0 max-w-full items-center gap-1.5 self-start text-2xs text-muted transition-colors hover:text-content"
        :aria-label="t(`agents.parentMark.startedBy`, { title })"
        v-tooltip.top="t(`agents.parentMark.startedBy`, { title })"
        @click.stop
    >
        <Icon name="subagents" class="shrink-0 text-2xs" />
        <span class="truncate">{{ title }}</span>
    </RouterLink>
</template>

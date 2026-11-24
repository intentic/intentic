<script setup lang="ts">
import { Button, Icon, SectionHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted } from "vue";
import RailCard from "../../features/chat/tabs/RailCard.vue";
import { standingChip } from "../../models/agent-status/agentStatus-chips";
import { laneOf, tileRim } from "../../models/agent-status/agentStatus-lanes";
import { activityIcon, activityLine, agentDisplayTitle, agentStatusMeta, cornerInk, cornerStandingShown } from "../../models/agent-status/agentStatus-meta";
import { turnInFlight } from "../../models/agent-status/agentStatus-standing";
import { previewOf } from "../../models/conversations/panel/useChat-strip";
import { useChat } from "../../models/conversations/run/useChat";
import { startAgent } from "../../models/fleet/agentActions";
import { useAgents } from "../../models/fleet/useAgents";
import type { FleetAgent } from "../../models/fleet/useAgents-fleet";

/* THIS FOLDER'S CONVERSATIONS, beside the chat (LocalAgents.vue): one row each, newest first, drawn with the rail's own
   card (features/chat/tabs/RailCard.vue) so a row says what a sandbox's would: its harness, its title, what it waits on
   or how long it has been working. Not the board: a board sorts work kept apart from the tree into lanes that end in
   landing it, and a conversation here has no such work to land. A press opens the conversation in the chat. */

const t = useT();
const agents = useAgents();
const { activeId } = useChat();

// The roster arrives on the window's event stream as conversations move; this is the first read of it.
onMounted(() => void agents.refresh());

const rowOf = (agent: FleetAgent) => {
    const meta = agentStatusMeta(agent.status);
    const working = turnInFlight(agent);
    return {
        agent,
        title: agentDisplayTitle(agent, previewOf(agent.id)),
        status: cornerStandingShown(agent.status) ? { name: meta.icon, spin: meta.spin, class: `text-xs ${cornerInk(meta.class)}`, "aria-label": meta.label } : undefined,
        chip: standingChip(agent),
        rim: tileRim(agent, { quiet: false }),
        live: working ? { icon: activityIcon(agent.activity?.tool), text: activityLine(agent) ?? t(`ui.status.working`), since: agent.startedAt } : undefined,
        at: working || agent.updatedAt <= 0 ? undefined : agent.updatedAt,
        attention: laneOf(agent) === `attention`,
    };
};

const rows = computed(() => agents.fleet.value.toSorted((a, b) => b.updatedAt - a.updatedAt).map(rowOf));
</script>

<template>
    <aside class="flex min-h-0 flex-col bg-card" :aria-label="t(`local.agents.conversations`)">
        <SectionHeader :label="t(`local.agents.conversations`)" :heading="2" density="dense" class="px-3 pt-3 pb-2">
            <template #actions>
                <Button tier="boring" size="small" :label="t(`local.agents.newConversation`)" @click="startAgent()">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </template>
        </SectionHeader>
        <div class="scrollbar-none flex min-h-0 flex-1 flex-col gap-(--rail-row-gap) overflow-y-auto px-2 pb-3">
            <RailCard
                v-for="row in rows"
                :key="row.agent.id"
                :title="row.title"
                :provider="row.agent.provider"
                :session="row.agent"
                :status="row.status"
                :chip="row.chip"
                :rim="row.rim"
                :live="row.live"
                :at="row.at"
                :selected="row.agent.id === activeId"
                :attention="row.attention"
                @click="agents.open(row.agent)"
            />
            <p v-if="agents.rosterKnown.value && rows.length === 0" class="px-2 py-6 text-center text-2xs text-subtle">
                {{ t(`local.agents.noConversations`) }}
            </p>
        </div>
    </aside>
</template>

<!-- Lists personas with pinned chats; unpinned chats stay in the Agents list. -->
<script setup lang="ts">
import { personaBounds, providerLabel } from "@intentic/sandbox-contract";
import { ui, Icon, type IconName, PersonaFace, StatusBadge } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import {
    activityIcon,
    activityLine,
    agentStatusMeta,
    blocked,
    type FleetLane,
    type StandingChip,
    standingChip,
    turnInFlight,
} from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { relativeTime, statusIcon, statusLabel } from "../models/catalog";
import { modelLabelFor } from "../accounts/providerCatalog";
import type { Conversation } from "../session/conversation";
import { laneOfTab, tabLabel } from "../tabs/tabs";
import { useChat } from "../run/useChat";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import RailCard from "../../../components/RailCard.vue";
import { useT } from "@intentic/ui/i18n";

// The host focuses the chat; this list only emits verbs, never writes the store directly.
const t = useT();

const emit = defineEmits<{ select: [id: string] }>();

const { personas } = usePersonas();
const { activeId, conversations } = useChat();
const { agentById } = useAgents();

// Chats this window holds for a persona: the pick lives on the conversation (ComposerSelection.actsAs), so this can only
// report what's in this window's own tabs, not the whole fleet.
const chatsOf = (id: string) =>
    conversations.value
        .filter((conversation) => conversation.selection.actsAs.value === id)
        .map((conversation) => ({ conversation, agent: agentById(conversation.conversationId) }))
        .toSorted((a, b) => (b.agent?.updatedAt ?? 0) - (a.agent?.updatedAt ?? 0));

// The chat this rail rings on arrival, seeded once at mount from the focused chat if it names a persona; a plain ref,
// not a live mirror, so switching focus elsewhere while this list is up doesn't drag the ring with it.
const arrivedIn = conversations.value.find(
    (conversation) => conversation.conversationId === activeId.value && conversation.selection.actsAs.value !== undefined,
);
const arrivedAs = arrivedIn?.selection.actsAs.value;
const picked = ref<string | undefined>(arrivedIn?.conversationId);

// A chat of this persona's, as the row's two halves (conversation + agent) read it.
type PersonaChat = { conversation: Conversation; agent: FleetAgent | undefined };

// The status glyph and its label, from the agent's own state where tracked, else the conversation's; shared with the
// expanded chat list below so a persona's glyph and its chats' glyphs never disagree.
const statusOf = (entry: PersonaChat): { name: IconName; spin?: boolean; class: string; "aria-label": string } => {
    if (entry.agent !== undefined) {
        const meta = agentStatusMeta(entry.agent.status);
        return { name: meta.icon, spin: meta.spin, class: `text-xs ${meta.class}`, "aria-label": meta.label };
    }
    const status = entry.conversation.status.value;
    const icon = statusIcon(status);
    return { name: icon.name, spin: icon.spin, class: `text-xs ${icon.class}`, "aria-label": statusLabel(status) };
};

// The same corner word the lanes list and the board draw (agentStatus.standingChip): a chat of this persona's parked
// on a question says so here too, rather than leaving the reader a glyph to interpret.
const chipOf = (entry: PersonaChat): StandingChip | undefined => (entry.agent === undefined ? undefined : standingChip(entry.agent));

// Which of a persona's chats the row speaks for: a turn in flight first, else the most recent, else none — undefined
// is a distinct state, not a gap, for a persona with no chats here yet.
const leadOf = (mine: readonly PersonaChat[]): PersonaChat | undefined =>
    mine.find((entry) => entry.agent !== undefined && turnInFlight(entry.agent)) ??
    mine.find((entry) => entry.conversation.turn.streaming.value) ??
    mine[0];

// What it runs on: the agent's recorded model, else the last turn's, else what the composer would send next, else the
// bare provider. Must agree with ChatTabList.modelOf and AgentRow.model.
const modelOf = (entry: PersonaChat | undefined): string | undefined => {
    if (entry === undefined) {
        return undefined;
    }
    const provider = entry.agent?.provider ?? entry.conversation.selection.provider.value;
    const model = entry.agent?.model ?? entry.conversation.activeModel.value ?? entry.conversation.selection.model.value;
    return model !== null && model !== `` ? modelLabelFor(provider, model) : providerLabel(provider);
};

// What it's doing right now, read from whichever half is tracking the turn; the registry's activity is richer (tool
// name), a streaming conversation the roster hasn't caught up with still reports running.
const liveOf = (entry: PersonaChat | undefined): { icon: IconName; text: string; since: number | undefined } | undefined => {
    if (entry === undefined) {
        return undefined;
    }
    const { agent, conversation } = entry;
    if (agent !== undefined && turnInFlight(agent)) {
        return {
            icon: (agent.subagents?.running ?? 0) > 0 ? `users` : activityIcon(agent.activity?.tool),
            text: activityLine(agent) ?? t(`chat.chatPersonaRail.working`),
            since: agent.startedAt,
        };
    }
    return conversation.turn.streaming.value ? { icon: activityIcon(undefined), text: t(`chat.chatPersonaRail.working`), since: conversation.turn.turnStartedAt.value } : undefined;
};

interface PersonaRow {
    readonly key: string;
    readonly id: string;
    readonly label: string;
    readonly bounds: string | undefined;
    // What the lead chat runs on, and what it's doing: the row's one line of facts.
    readonly model: string | undefined;
    readonly live: { icon: IconName; text: string; since: number | undefined } | undefined;
    // The persona's standing glyph, off the same lead chat; spins while a turn is in flight.
    readonly status: { name: IconName; spin?: boolean; class: string } | undefined;
    readonly chats: number;
    readonly lastAt: number | undefined;
    readonly needsYou: boolean;
    readonly open: boolean;
}

// One row per persona, nothing else: no "Anyone" row here, since an unpinned chat already has a home in the Agents
// cut, and grouping them here would outweigh the personas the list exists to show.
const rows = computed<PersonaRow[]>(() =>
    personas.value.map((persona) => {
        const mine = chatsOf(persona.id);
        const lead = leadOf(mine);
        return {
            key: persona.id,
            id: persona.id,
            label: persona.label ?? persona.id,
            bounds: persona.powers === undefined ? undefined : personaBounds(persona),
            model: modelOf(lead),
            live: liveOf(lead),
            status: lead === undefined ? undefined : statusOf(lead),
            chats: mine.length,
            lastAt: mine[0]?.agent?.updatedAt,
            // Same attention channel a session row uses: one of this persona's chats is waiting on you.
            needsYou: mine.some((entry) => entry.agent !== undefined && blocked(entry.agent)),
            // Ringed only for a chat opened from here; see `picked`.
            open: mine.some((entry) => entry.conversation.conversationId === picked.value),
        };
    }),
);

const empty = computed(() => personas.value.length === 0);

// Switching chats or starting a fresh one both land here; the ring follows whichever this rail put on screen.
const show = (conversationId: string): void => {
    picked.value = conversationId;
    emit(`select`, conversationId);
};
const startAs = (row: PersonaRow): void => {
    picked.value = startAgent(undefined, row.id);
};

// Pressing a persona row toggles its own chat list, rather than jumping straight to a chat: a list this scanned needs a
// reversible default press, with switching and starting a new chat as deliberate second presses inside the opened
// group.
// The persona you arrived inside starts expanded, since its row is already ringed and a collapsed group over it would
// hide the very chat being highlighted. Seeded here rather than left to the watch below, which only fires on change.
const expanded = ref<Set<string>>(new Set(arrivedAs === undefined ? [] : [arrivedAs]));
const isExpanded = (row: PersonaRow): boolean => expanded.value.has(row.key);
const toggleExpanded = (row: PersonaRow): void => {
    const next = new Set(expanded.value);
    if (!next.delete(row.key)) {
        next.add(row.key);
    }
    expanded.value = next;
};

// A persona opened from this rail (not from elsewhere) expands itself, keyed to this rail's own pick so a chat focused
// elsewhere doesn't spring a group open; a reader who collapses it afterward stays collapsed.
watch(
    () => rows.value.find((row) => row.open)?.key,
    (key) => {
        if (key !== undefined && !expanded.value.has(key)) {
            expanded.value = new Set(expanded.value).add(key);
        }
    },
);

// Inside a group: needs-you, then running, then finished, newest first within each — the same order every session list
// in this app uses.
const LANE_RANK: Record<FleetLane, number> = { attention: 0, active: 1, finished: 2 };
const sessionsOf = (row: PersonaRow) =>
    chatsOf(row.id).toSorted(
        (a, b) =>
            LANE_RANK[laneOfTab(a.conversation, a.agent)] - LANE_RANK[laneOfTab(b.conversation, b.agent)] ||
            (b.agent?.updatedAt ?? 0) - (a.agent?.updatedAt ?? 0),
    );
</script>

<template>
    <!-- No slab: the other half of this rail (the lanes) has none either, and the rows take their step up from `--card-rest`. -->
    <div class="flex min-h-0 min-w-0 flex-col p-2">
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            <template v-if="empty">
                <!-- A real link, since the sandbox hub has an address and this is often the first place someone finds it. -->
                <RouterLink to="/sandbox/personas" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)">
                    <Icon name="plus" class="text-2xs" />
                    {{ t(`chat.chatPersonaRail.setUpPersona`) }}
                </RouterLink>
            </template>

            <template v-else>
                <template v-for="row in rows" :key="row.key">
                    <!-- Running personas expose status and live activity in the row. -->
                    <RailCard
                        :title="row.label"
                        :status="row.status"
                        :live="row.live"
                        tight
                        :selected="row.open"
                        :attention="row.needsYou"
                        :aria-expanded="isExpanded(row)"
                        :aria-label="t(`chat.chatPersonaRail.showSChats`, { label: row.label })"
                        @click="toggleExpanded(row)"
                    >
                        <!-- The persona face leads the row at its standard size. -->
                        <template #aside>
                            <!-- The face's default size sets the row height. -->
                            <PersonaFace :persona="row" />
                        </template>
                        <!-- The clock rides the title line, so gaining one never changes the row's height. -->
                        <template #trailing>
                            <span v-if="row.lastAt !== undefined && row.lastAt > 0" class="shrink-0 text-2xs text-subtle">{{
                                relativeTime(row.lastAt)
                            }}</span>
                        </template>
                        <!-- Model, bounds, and activity share one non-wrapping metadata line. -->
                        <template #meta>
                            <span class="flex min-h-4 min-w-0 flex-1 items-center gap-2 overflow-hidden">
                                <!-- The model leads the metadata line. -->
                                <span v-if="row.model !== undefined" class="min-w-0 truncate text-subtle">{{ row.model }}</span>
                                <!-- Bounds follow the model as static configuration. -->
                                <StatusBadge v-if="row.bounds !== undefined" variant="neutral" size="xs">{{ row.bounds }}</StatusBadge>
                                <!-- Hidden at zero (a fresh persona is simply fresh). -->
                                <span v-if="row.chats > 0" class="flex shrink-0 items-center gap-0.5 text-muted">
                                    {{ row.chats }} {{ t(`chat.chatPersonaRail.chat`) }}{{ row.chats === 1 ? `` : `s` }}
                                    <Icon :name="isExpanded(row) ? `chevron-up` : `chevron-down`" class="text-2xs" />
                                </span>
                            </span>
                        </template>
                    </RailCard>

                    <!-- Persona chats are grouped beneath the persona row. -->
                    <!-- Group indentation keeps full-width chat rows inside the rail. -->
                    <!-- Chat rows reuse the persona's live activity source. -->
                    <div v-if="isExpanded(row)" class="ml-5 flex min-w-0 flex-col gap-2">
                        <RailCard
                            v-for="entry in sessionsOf(row)"
                            :key="entry.conversation.conversationId"
                            :title="tabLabel(entry.conversation)"
                            :title-action="entry.agent?.titleAction"
                            :provider="entry.agent?.provider ?? entry.conversation.selection.provider.value"
                            :status="statusOf(entry)"
                            :chip="chipOf(entry)"
                            :live="liveOf(entry)"
                            tight
                            :selected="entry.conversation.conversationId === picked"
                            :attention="entry.agent !== undefined && blocked(entry.agent)"
                            :aria-label="t(`chat.chatPersonaRail.open`, { conversation: tabLabel(entry.conversation) })"
                            @click="show(entry.conversation.conversationId)"
                        >
                            <template #trailing>
                                <span v-if="entry.agent !== undefined && entry.agent.updatedAt > 0" class="shrink-0 text-2xs text-subtle">{{
                                    relativeTime(entry.agent.updatedAt)
                                }}</span>
                            </template>
                        </RailCard>
                        <!-- Existing chat groups always retain a start-chat action. -->
                        <button type="button" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)" @click="startAs(row)">
                            <Icon name="plus" class="text-2xs" />
                            {{ t(`chat.chatPersonaRail.newChat`) }} {{ row.label }}
                        </button>
                    </div>
                </template>

                <!-- Link to the page that owns these rows, in the same place the composer's picker puts it. -->
                <RouterLink to="/sandbox/personas" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)">
                    <Icon name="cog" class="text-2xs" />
                    {{ t(`chat.chatPersonaRail.managePersonas`) }}
                </RouterLink>
            </template>
        </div>
    </div>
</template>

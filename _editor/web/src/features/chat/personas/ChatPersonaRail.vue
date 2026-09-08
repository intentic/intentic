<!--
    Lists personas (Work, Inbox Manager, …) to chat with — the chat list's persona cut (chatGrouping.ts). Pressing a row opens the most recent chat
    pinned to that persona, or starts a fresh one; opens ringed on whichever persona the current chat is already pinned to. No 'Anyone' row —
    unpinned chats live in the Agents cut, not here.
-->
<script setup lang="ts">
import { personaBounds, providerLabel } from "@intentic/sandbox-contract";
import { ui, Icon, type IconName, PersonaFace, StatusBadge } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import { activityIcon, activityLine, agentStatusMeta, blocked, type FleetLane, turnInFlight } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { relativeTime, statusIcon, statusLabel } from "../models/catalog";
import { modelLabelFor } from "../accounts/providerCatalog";
import type { Conversation } from "../session/conversation";
import { laneOfTab, tabLabel } from "../tabs/tabs";
import { useChat } from "../run/useChat";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import RailCard from "../../../components/RailCard.vue";

// The host focuses the chat; this list only emits verbs, never writes the store directly.
const emit = defineEmits<{ select: [id: string] }>();

const { personas } = usePersonas();
const { activeId, conversations } = useChat();
const { agentById } = useAgents();

// Chats this window holds for a persona: the pick lives on the conversation (Conversation.actsAs), so this can only
// report what's in this window's own tabs, not the whole fleet.
const chatsOf = (id: string) =>
    conversations.value
        .filter((conversation) => conversation.actsAs.value === id)
        .map((conversation) => ({ conversation, agent: agentById(conversation.conversationId) }))
        .toSorted((a, b) => (b.agent?.updatedAt ?? 0) - (a.agent?.updatedAt ?? 0));

// The chat this rail rings on arrival, seeded once at mount from the focused chat if it names a persona; a plain ref,
// not a live mirror, so switching focus elsewhere while this list is up doesn't drag the ring with it.
const arrivedIn = conversations.value.find(
    (conversation) => conversation.conversationId === activeId.value && conversation.actsAs.value !== undefined,
);
const arrivedAs = arrivedIn?.actsAs.value;
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

// Which of a persona's chats the card speaks for: a turn in flight first, else the most recent, else none — undefined
// is a distinct state, not a gap, for a persona with no chats here yet.
const leadOf = (mine: readonly PersonaChat[]): PersonaChat | undefined =>
    mine.find((entry) => entry.agent !== undefined && turnInFlight(entry.agent)) ??
    mine.find((entry) => entry.conversation.streaming.value) ??
    mine[0];

// What it runs on: the agent's recorded model, else the last turn's, else what the composer would send next, else the
// bare provider. Must agree with ChatTabList.modelOf and AgentCard.model.
const modelOf = (entry: PersonaChat | undefined): string | undefined => {
    if (entry === undefined) {
        return undefined;
    }
    const provider = entry.agent?.provider ?? entry.conversation.provider.value;
    const model = entry.agent?.model ?? entry.conversation.activeModel.value ?? entry.conversation.model.value;
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
            text: activityLine(agent) ?? `Working…`,
            since: agent.startedAt,
        };
    }
    return conversation.streaming.value ? { icon: activityIcon(undefined), text: `Working…`, since: conversation.turnStartedAt.value } : undefined;
};

interface PersonaRow {
    readonly key: string;
    readonly id: string;
    readonly label: string;
    readonly bounds: string | undefined;
    // What the lead chat runs on, and what it's doing: the card's one line of facts.
    readonly model: string | undefined;
    readonly live: { icon: IconName; text: string; since: number | undefined } | undefined;
    // The persona's standing glyph, off the same lead chat; spins while a turn is in flight.
    readonly status: { name: IconName; spin?: boolean; class: string } | undefined;
    readonly chats: number;
    readonly lastAt: number | undefined;
    readonly needsYou: boolean;
    readonly open: boolean;
}

// One row per persona card, nothing else: no "Anyone" row here, since an unpinned chat already has a home in the Agents
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
            // Same attention channel a session card uses: one of this persona's chats is waiting on you.
            needsYou: mine.some((entry) => entry.agent !== undefined && blocked(entry.agent)),
            // Ringed only for a chat opened from here; see `picked`.
            open: mine.some((entry) => entry.conversation.conversationId === picked.value),
        };
    }),
);

const empty = computed(() => personas.value.length === 0);

// One shared clock for the whole column, so every card's elapsed readout ticks together instead of drifting apart.
const now = useNow();

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
    <!--
        The card is the app's one shared `.session-card`; it must never sit on the same `--color-card` ground, or it turns invisible. This grounds it
        on canvas (not `.lane`'s 3%-mixed ground), matching the Agents view's card-over-canvas look; the well itself doesn't scroll, only its
        contents, so the rounded corners stay in view.
    -->
    <div class="flex min-h-0 min-w-0 flex-col rounded-xl bg-canvas p-2">
        <div class="scrollbar-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        <template v-if="empty">
            <!-- A real link, since the sandbox hub has an address and this is often the first place someone finds it. -->
            <RouterLink to="/sandbox/personas" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)">
                <Icon name="plus" class="text-2xs" />
                Set up a persona
            </RouterLink>
        </template>

        <template v-else>
            <template v-for="row in rows" :key="row.key">
                <!--
                    `status` and `live`+`tight` match the board's own arrangement, so a running persona actually looks different from an idle one.
                    `now` is the column's shared tick, keeping the elapsed readout counting instead of frozen.
                -->
                <RailCard
                    :title="row.label"
                    :status="row.status"
                    :live="row.live"
                    :now="now"
                    tight
                    :selected="row.open"
                    :attention="row.needsYou"
                    :aria-expanded="isExpanded(row)"
                    :aria-label="`Show ${row.label}'s chats`"
                    @click="toggleExpanded(row)"
                >
                    <!--
                        The face leads at card height, since this list is scanned for a person before a name; generated from the persona's id, so it
                        matches the composer's picker and the personas page.
                    -->
                    <template #aside>
                        <!--
                            No explicit size: the face's own default sets the row's height (it's taller than the two text lines beside it), so sizing
                            it from the card instead would depend on a height the card is still waiting on the face to set.
                        -->
                        <PersonaFace :persona="row" />
                    </template>
                    <!-- The clock rides the title line, so gaining one never changes the row's height. -->
                    <template #trailing>
                        <span v-if="row.lastAt !== undefined && row.lastAt > 0" class="shrink-0 text-2xs text-subtle">{{
                            relativeTime(row.lastAt)
                        }}</span>
                    </template>
                    <!--
                        Composed into one flex child rather than several: letting the count or clock wrap onto a second line would grow the card
                        under the cursor that just clicked it.
                    -->
                    <template #meta>
                        <span class="flex min-h-4 min-w-0 flex-1 items-center gap-2 overflow-hidden">
                            <!--
                                Model leads the line, matching the board's left-model/right-activity arrangement so the scanned fact sits at the same
                                x on every row. It's the only child that truncates, keeping the line from wrapping.
                            -->
                            <span v-if="row.model !== undefined" class="min-w-0 truncate text-subtle">{{ row.model }}</span>
                            <!--
                                What a bounded persona may reach; placed after the model since this is static configuration, unlike the rest of the
                                line.
                            -->
                            <StatusBadge v-if="row.bounds !== undefined" variant="neutral" size="xs">{{ row.bounds }}</StatusBadge>
                            <!--
                                Hidden at zero (a fresh persona is simply fresh). Plain text and a chevron now, not its own control: the whole card
                                is the disclosure, so a second nested button here would only announce the same press twice.
                            -->
                            <span v-if="row.chats > 0" class="flex shrink-0 items-center gap-0.5 text-muted">
                                {{ row.chats }} chat{{ row.chats === 1 ? `` : `s` }}
                                <Icon :name="isExpanded(row) ? `chevron-up` : `chevron-down`" class="text-2xs" />
                            </span>
                        </span>
                    </template>
                </RailCard>

                <!--
                    The persona's own chats, indented under it: the same board card at rail width, carrying only what a one-line row can (which one,
                    what it's doing, when).
                -->
                <!-- Indent lives on the group, not the cards: a `w-full` card with its own margin would push the whole run past the rail's edge. -->
                <!--
                    Chats share the same live readout as the persona row above, off the same turns, so the group can't disagree with what it just
                    opened.
                -->
                <div v-if="isExpanded(row)" class="ml-5 flex min-w-0 flex-col gap-2">
                    <RailCard
                        v-for="entry in sessionsOf(row)"
                        :key="entry.conversation.conversationId"
                        :title="tabLabel(entry.conversation)"
                        :provider="entry.agent?.provider ?? entry.conversation.provider.value"
                        :status="statusOf(entry)"
                        :live="liveOf(entry)"
                        :now="now"
                        tight
                        :selected="entry.conversation.conversationId === picked"
                        :attention="entry.agent !== undefined && blocked(entry.agent)"
                        :aria-label="`Open ${tabLabel(entry.conversation)}`"
                        @click="show(entry.conversation.conversationId)"
                    >
                        <template #trailing>
                            <span v-if="entry.agent !== undefined && entry.agent.updatedAt > 0" class="shrink-0 text-2xs text-subtle">{{
                                relativeTime(entry.agent.updatedAt)
                            }}</span>
                        </template>
                    </RailCard>
                    <!--
                        Without this, a persona with existing chats has no way to start another one from here; it sits below them since that's the
                        order the question arrives in.
                    -->
                    <button type="button" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)" @click="startAs(row)">
                        <Icon name="plus" class="text-2xs" />
                        New chat as {{ row.label }}
                    </button>
                </div>
            </template>

            <!-- Link to the page that owns these cards, in the same place the composer's picker puts it. -->
            <RouterLink to="/sandbox/personas" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)">
                <Icon name="cog" class="text-2xs" />
                Manage personas
            </RouterLink>
        </template>
        </div>
    </div>
</template>

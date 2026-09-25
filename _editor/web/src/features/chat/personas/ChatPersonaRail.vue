<!-- The rail's Personas cut: the same open chats as the Agents cut, grouped by who they act as, plus each persona's live work that isn't open here. -->
<script setup lang="ts">
import { personaBounds } from "@intentic/sandbox-contract";
import { ContextMenu, FACE_SIZES, Icon, type IconName, PersonaFace, StatusBadge, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import {
    activityIcon,
    activityLine,
    agentDisplayTitle,
    agentStatusMeta,
    type FleetLane,
    laneOf,
    standingChip,
    turnInFlight,
    unregistered,
} from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { canArchive, type FleetAgent, finishedLaneOrder } from "../../agents/fleet/useAgents-fleet";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import RailCard from "../../../components/RailCard.vue";
import { relativeTime } from "../models/catalog";
import { previewOf } from "../panel/useChat-strip";
import { useChat } from "../run/useChat";
import type { OpenChat } from "../tabs/cardView";
import ChatRowList from "../tabs/ChatRowList.vue";
import { untouchedDraft } from "../tabs/tabFacts";
import { laneOfTab, personaOfTab, tabsOfPersona } from "../tabs/tabs";
import { injectChatRowActions } from "../tabs/useChatRowActions";
import { ANYONE, usePersonaExpanded } from "./personaExpanded";

const t = useT();
const router = useRouter();

const { personas } = usePersonas();
const { activeId, conversations } = useChat();
const { agentById, fleet, archive, open } = useAgents();
const actions = injectChatRowActions();
const { isExpanded, toggle, open: expand } = usePersonaExpanded();

// A group shows this many finished chats before folding the rest; smaller than a lane's, since several groups share the column.
const GROUP_FINISHED = 3;
// Not-open conversations a group lists before sending the reader to the board for the rest.
const BACKGROUND_SHOWN = 5;

const known = computed(() => new Set(personas.value.map((persona) => persona.id)));
const keyOf = (persona: string | undefined): string => persona ?? ANYONE;

const LANE_RANK: Record<FleetLane, number> = { attention: 0, active: 1, finished: 2 };

// Every open chat under exactly one key: pinned first, then needs-you, working, finished, newest first within each.
const openBy = computed(() => {
    const groups = new Map<string, OpenChat[]>();
    for (const conversation of conversations.value) {
        const key = keyOf(personaOfTab(conversation, known.value));
        // A blank nobody has typed into is the panel's resting state, not a chat: it names no persona to sit under.
        if (key === ANYONE && untouchedDraft(conversation)) {
            continue;
        }
        const entry = { conversation, agent: agentById(conversation.conversationId) };
        groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const rank = (entry: OpenChat): number => LANE_RANK[laneOfTab(entry.conversation, entry.agent)];
    for (const [key, entries] of groups) {
        groups.set(
            key,
            entries.toSorted(
                (a, b) =>
                    Number(b.conversation.pinned.value) - Number(a.conversation.pinned.value) ||
                    rank(a) - rank(b) ||
                    (a.agent !== undefined && b.agent !== undefined && rank(a) === 2 ? finishedLaneOrder(a.agent, b.agent) : 0) ||
                    (b.agent?.updatedAt ?? 0) - (a.agent?.updatedAt ?? 0),
            ),
        );
    }
    return groups;
});

// A persona's live conversations this window has not opened: its automations, its other windows' chats, its runs.
const openIds = computed(() => new Set(conversations.value.map((conversation) => conversation.conversationId)));
const backgroundBy = computed(() => {
    const groups = new Map<string, FleetAgent[]>();
    for (const agent of fleet.value) {
        if (
            agent.actsAs === undefined ||
            !known.value.has(agent.actsAs) ||
            openIds.value.has(agent.id) ||
            agent.sandboxId !== undefined ||
            unregistered(agent.status)
        ) {
            continue;
        }
        groups.set(agent.actsAs, [...(groups.get(agent.actsAs) ?? []), agent]);
    }
    for (const [key, agents] of groups) {
        groups.set(key, agents.toSorted((a, b) => LANE_RANK[laneOf(a)] - LANE_RANK[laneOf(b)] || b.updatedAt - a.updatedAt));
    }
    return groups;
});

type Live = { icon: IconName; text: string; since: number | undefined };
const liveOfAgent = (agent: FleetAgent): Live => ({
    icon: (agent.subagents?.running ?? 0) > 0 ? `users` : activityIcon(agent.activity?.tool),
    text: activityLine(agent) ?? t(`ui.status.working`),
    since: agent.startedAt,
});
const working = (entry: OpenChat): boolean =>
    entry.agent !== undefined ? turnInFlight(entry.agent) : entry.conversation.turn.streaming.value;

interface Group {
    readonly key: string;
    // Undefined for the Anyone group.
    readonly persona: { id: string; label: string; bounds: string | undefined } | undefined;
    readonly label: string;
    readonly open: readonly OpenChat[];
    readonly background: readonly FleetAgent[];
    readonly needsYou: number;
    readonly working: number;
    readonly lastAt: number | undefined;
    readonly live: Live | undefined;
    readonly status: { name: IconName; spin?: boolean; class: string } | undefined;
    readonly holdsFocus: boolean;
}

const groupOf = (key: string, persona: Group[`persona`], label: string): Group => {
    const mine = openBy.value.get(key) ?? [];
    const background = persona === undefined ? [] : (backgroundBy.value.get(persona.id) ?? []);
    const runningOpen = mine.find(working);
    const runningBackground = background.find(turnInFlight);
    const live =
        runningOpen === undefined
            ? runningBackground === undefined
                ? undefined
                : liveOfAgent(runningBackground)
            : runningOpen.agent !== undefined
              ? liveOfAgent(runningOpen.agent)
              : { icon: activityIcon(undefined), text: t(`ui.status.working`), since: runningOpen.conversation.turn.turnStartedAt.value };
    const lead = runningOpen?.agent ?? runningBackground;
    const leadMeta = lead === undefined ? undefined : agentStatusMeta(lead.status);
    const stamps = [...mine.map((entry) => entry.agent?.updatedAt ?? 0), ...background.map((agent) => agent.updatedAt)].filter((at) => at > 0);
    return {
        key,
        persona,
        label,
        open: mine,
        background,
        needsYou:
            mine.filter((entry) => laneOfTab(entry.conversation, entry.agent) === `attention`).length +
            background.filter((agent) => laneOf(agent) === `attention`).length,
        working: mine.filter(working).length + background.filter(turnInFlight).length,
        lastAt: stamps.length === 0 ? undefined : Math.max(...stamps),
        live,
        status: leadMeta === undefined ? undefined : { name: leadMeta.icon, spin: leadMeta.spin, class: `text-xs ${leadMeta.class}` },
        holdsFocus: mine.some((entry) => entry.conversation.conversationId === activeId.value),
    };
};

// Personas with something open or live, in the order personas.json lists them; the rest wait as start tiles below.
const personaGroups = computed(() =>
    personas.value.map((persona) =>
        groupOf(
            persona.id,
            { id: persona.id, label: persona.label ?? persona.id, bounds: persona.powers === undefined ? undefined : personaBounds(persona) },
            persona.label ?? persona.id,
        ),
    ),
);
const busy = computed(() => personaGroups.value.filter((group) => group.open.length > 0 || group.needsYou > 0 || group.working > 0));
const idle = computed(() => personaGroups.value.filter((group) => !busy.value.includes(group)));
const anyone = computed(() => groupOf(ANYONE, undefined, t(`chat.words.anyone`)));
const groups = computed(() => [...busy.value, ...(anyone.value.open.length > 0 ? [anyone.value] : [])]);

// Focus landing in a group opens it; a reader who folds it afterwards keeps it folded until focus moves elsewhere.
watch(
    () => groups.value.find((group) => group.holdsFocus)?.key,
    (key) => {
        if (key !== undefined) {
            expand(key);
        }
    },
    { immediate: true },
);

// Finished chats past the group's fold, unless the reader lifted it; pinned ones and the focused one always show.
const unfolded = ref<ReadonlySet<string>>(new Set());
const shownBy = computed(() => {
    const shown = new Map<string, { entries: OpenChat[]; hidden: number }>();
    const folds = (entry: OpenChat): boolean => !entry.conversation.pinned.value && laneOfTab(entry.conversation, entry.agent) === `finished`;
    for (const group of groups.value) {
        if (unfolded.value.has(group.key)) {
            shown.set(group.key, { entries: [...group.open], hidden: 0 });
            continue;
        }
        const tail = group.open.filter(folds);
        const kept = tail.filter((entry, at) => at < GROUP_FINISHED || entry.conversation.conversationId === activeId.value);
        shown.set(group.key, { entries: [...group.open.filter((entry) => !folds(entry)), ...kept], hidden: tail.length - kept.length });
    }
    return shown;
});
const shownOf = (group: Group): { entries: OpenChat[]; hidden: number } => shownBy.value.get(group.key) ?? { entries: [], hidden: 0 };
const flipped = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (!next.delete(key)) {
        next.add(key);
    }
    return next;
};
const toggleUnfolded = (key: string): void => {
    unfolded.value = flipped(unfolded.value, key);
};

// The not-open list: anything waiting on the reader stands in the group itself; the rest waits behind its own fold.
const backgroundShown = ref<ReadonlySet<string>>(new Set());
const toggleBackground = (key: string): void => {
    backgroundShown.value = flipped(backgroundShown.value, key);
};
const waiting = (group: Group): FleetAgent[] => group.background.filter((agent) => laneOf(agent) === `attention`);
const quiet = (group: Group): FleetAgent[] => group.background.filter((agent) => laneOf(agent) !== `attention`);

const startAs = (group: Group): void => {
    startAgent(undefined, group.persona?.id);
};

// The header's own menu: what can be done to the whole group at once. Sweeps skip pinned chats (tabsOfPersona).
const groupMenu = ref<{ show: (event: Event) => void } | undefined>();
const menuGroup = ref<string>();
const NO_ITEMS: MenuItem[] = [];
const archivableOf = (group: Group): string[] => [
    ...group.open
        .filter(
            (entry) =>
                entry.agent !== undefined &&
                entry.conversation.box.value === undefined &&
                laneOf(entry.agent) === `finished` &&
                canArchive(entry.agent),
        )
        .map((entry) => entry.conversation.conversationId),
    ...group.background.filter((agent) => laneOf(agent) === `finished` && canArchive(agent)).map((agent) => agent.id),
];
const groupMenuItems = computed<MenuItem[]>(() => {
    const group = [...groups.value, ...idle.value].find((candidate) => candidate.key === menuGroup.value);
    if (group === undefined) {
        return NO_ITEMS;
    }
    const persona = group.persona?.id;
    const finished = tabsOfPersona(persona, known.value, `finished`);
    const all = tabsOfPersona(persona, known.value);
    const archivable = archivableOf(group);
    return [
        {
            label: group.persona === undefined ? t(`chat.words.newAgent`) : t(`chat.chatPersonaRail.newChatAs`, { label: group.label }),
            icon: `plus`,
            command: () => startAs(group),
        },
        { separator: true },
        {
            label: t(`chat.chatPersonaRail.closeFinishedOf`, { label: group.label }),
            disabled: finished.size === 0,
            command: () => actions.closeSet(finished),
        },
        { label: t(`chat.chatPersonaRail.closeAllOf`, { label: group.label }), disabled: all.size === 0, command: () => actions.closeSet(all) },
        ...(group.persona === undefined
            ? []
            : [
                  {
                      label: t(`chat.chatPersonaRail.archiveFinishedOf`, { label: group.label }),
                      icon: `box`,
                      disabled: archivable.length === 0,
                      command: () => void archive(archivable),
                  },
                  { separator: true },
                  {
                      label: t(`chat.chatPersonaRail.editPersona`),
                      icon: `cog`,
                      command: () => void router.push({ path: `/sandbox/personas`, query: { open: persona } }),
                  },
              ]),
    ];
});
const openGroupMenu = (group: Group, event: Event): void => {
    menuGroup.value = group.key;
    groupMenu.value?.show(event);
};
// The × and the ⋯ sit inside the header's click target; stopping the press keeps them from also toggling the group.
const onHeaderAction = (event: Event, run: () => void): void => {
    event.stopPropagation();
    run();
};

const titleOf = (agent: FleetAgent): string => agentDisplayTitle(agent, previewOf(agent.id));
</script>

<template>
    <!-- No slab: the other half of this rail (the lanes) has none either, and the rows take their step up from `--card-rest`. -->
    <div class="flex min-h-0 min-w-0 flex-col p-2">
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            <template v-for="group in groups" :key="group.key">
                <!-- The header summarises the group, open or folded: what needs you, what works, and the lead chat's live line. -->
                <RailCard
                    :title="group.label"
                    :icon="group.persona === undefined ? `users` : undefined"
                    :status="group.status"
                    :live="group.live"
                    tight
                    :selected="group.holdsFocus && !isExpanded(group.key)"
                    :attention="group.needsYou > 0"
                    :aria-expanded="isExpanded(group.key)"
                    :aria-label="t(`chat.chatPersonaRail.showSChats`, { label: group.label })"
                    @click="toggle(group.key)"
                    @contextmenu.prevent.stop="openGroupMenu(group, $event)"
                >
                    <template v-if="group.persona !== undefined" #aside>
                        <PersonaFace :persona="group.persona" />
                    </template>
                    <template #trailing>
                        <span
                            role="button"
                            :aria-label="group.persona === undefined ? t(`chat.words.newAgent`) : t(`chat.chatPersonaRail.newChatAs`, { label: group.label })"
                            v-tooltip.top="group.persona === undefined ? t(`chat.words.newAgent`) : t(`chat.chatPersonaRail.newChatAs`, { label: group.label })"
                            class="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                            @click="onHeaderAction($event, () => startAs(group))"
                        >
                            <Icon name="plus" class="text-2xs" />
                        </span>
                        <span
                            role="button"
                            :aria-label="t(`chat.chatPersonaRail.more`, { label: group.label })"
                            class="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                            @click="onHeaderAction($event, () => openGroupMenu(group, $event))"
                        >
                            <Icon name="ellipsis" class="text-2xs" />
                        </span>
                        <span v-if="group.lastAt !== undefined" class="shrink-0 text-2xs text-subtle">{{ relativeTime(group.lastAt) }}</span>
                    </template>
                    <template #meta>
                        <span class="flex min-h-4 min-w-0 flex-1 items-center gap-2 overflow-hidden">
                            <span v-if="group.needsYou > 0" class="shrink-0 font-semibold text-warning">{{
                                t(`chat.chatPersonaRail.needsYou`, { count: group.needsYou }, group.needsYou)
                            }}</span>
                            <span v-if="group.working > 0" class="shrink-0">{{ t(`chat.chatPersonaRail.working`, { count: group.working }, group.working) }}</span>
                            <span v-if="group.needsYou === 0 && group.working === 0 && group.open.length > 0" class="shrink-0">{{
                                t(`chat.chatPersonaRail.chats`, { count: group.open.length }, group.open.length)
                            }}</span>
                            <StatusBadge v-if="group.persona?.bounds !== undefined" variant="neutral" size="xs">{{ group.persona.bounds }}</StatusBadge>
                            <Icon :name="isExpanded(group.key) ? `chevron-up` : `chevron-down`" class="ml-auto shrink-0 text-2xs" />
                        </span>
                    </template>
                </RailCard>

                <div v-if="isExpanded(group.key)" class="ml-5 flex min-w-0 flex-col gap-2">
                    <!-- The very rows the Agents cut draws, so every close, pin, rename and menu is here too. -->
                    <ChatRowList v-if="shownOf(group).entries.length > 0" :entries="shownOf(group).entries" />
                    <button
                        v-if="shownOf(group).hidden > 0 || unfolded.has(group.key)"
                        type="button"
                        :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                        @click="toggleUnfolded(group.key)"
                    >
                        <Icon :name="unfolded.has(group.key) ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ unfolded.has(group.key) ? t(`ui.action.showFewer`) : t(`shared.earlier`, { hiddenFinished: shownOf(group).hidden }) }}
                    </button>

                    <!-- Waiting on the reader, though not open here: never folded, since a question can't be answered unseen. -->
                    <RailCard
                        v-for="agent in waiting(group)"
                        :key="agent.id"
                        :title="titleOf(agent)"
                        :title-action="agent.titleAction"
                        :provider="agent.provider"
                        :chip="standingChip(agent)"
                        tight
                        quiet
                        attention
                        @click="open(agent, `peek`)"
                    />
                    <template v-if="quiet(group).length > 0">
                        <button
                            type="button"
                            :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                            :aria-expanded="backgroundShown.has(group.key)"
                            @click="toggleBackground(group.key)"
                        >
                            <Icon :name="backgroundShown.has(group.key) ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                            {{ t(`chat.chatPersonaRail.notOpen`, { count: quiet(group).length }, quiet(group).length) }}
                        </button>
                        <template v-if="backgroundShown.has(group.key)">
                            <RailCard
                                v-for="agent in quiet(group).slice(0, BACKGROUND_SHOWN)"
                                :key="agent.id"
                                :title="titleOf(agent)"
                                :title-action="agent.titleAction"
                                :provider="agent.provider"
                                :chip="standingChip(agent)"
                                :live="turnInFlight(agent) ? liveOfAgent(agent) : undefined"
                                tight
                                quiet
                                @click="open(agent, `peek`)"
                            >
                                <template v-if="!turnInFlight(agent) && agent.updatedAt > 0" #meta>
                                    <span class="ml-auto shrink-0">{{ relativeTime(agent.updatedAt) }}</span>
                                </template>
                            </RailCard>
                            <RouterLink
                                v-if="quiet(group).length > BACKGROUND_SHOWN"
                                to="/agents"
                                :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                            >
                                {{ t(`chat.chatPersonaRail.moreOnBoard`, { count: quiet(group).length - BACKGROUND_SHOWN }) }}
                            </RouterLink>
                        </template>
                    </template>

                    <!-- A group with nothing in it still offers its one next step. -->
                    <button
                        v-if="group.open.length === 0 && group.background.length === 0"
                        type="button"
                        :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                        @click="startAs(group)"
                    >
                        <Icon name="plus" class="text-2xs" />
                        {{ group.persona === undefined ? t(`chat.words.newAgent`) : t(`chat.chatPersonaRail.newChatAs`, { label: group.label }) }}
                    </button>
                </div>
            </template>

            <!-- Personas with nothing open or live: one press starts a chat as them, so they cost a line, not a card. -->
            <div v-if="idle.length > 0" class="flex min-w-0 flex-col gap-0.5" :class="{ 'mt-1': groups.length > 0 }">
                <button
                    v-for="group in idle"
                    :key="group.key"
                    type="button"
                    :aria-label="t(`chat.chatPersonaRail.startAs`, { label: group.label })"
                    v-tooltip.right="t(`chat.chatPersonaRail.newChatAs`, { label: group.label })"
                    class="group flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-2xs text-muted transition hover:bg-overlay hover:text-content"
                    @click="startAs(group)"
                    @contextmenu.prevent.stop="openGroupMenu(group, $event)"
                >
                    <PersonaFace v-if="group.persona !== undefined" :persona="group.persona" :size="FACE_SIZES.pill" />
                    <span class="min-w-0 flex-1 truncate font-medium">{{ group.label }}</span>
                    <Icon name="plus" class="shrink-0 text-2xs opacity-0 transition group-hover:opacity-100" />
                </button>
            </div>

            <!-- A real link, since the sandbox hub has an address and this is often the first place someone finds it. -->
            <RouterLink v-if="personas.length === 0" to="/sandbox/personas" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)">
                <Icon name="plus" class="text-2xs" />
                {{ t(`chat.words.setUpPersona`) }}
            </RouterLink>
            <RouterLink v-else to="/sandbox/personas" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)">
                <Icon name="cog" class="text-2xs" />
                {{ t(`chat.words.managePersonas`) }}
            </RouterLink>
        </div>
        <ContextMenu ref="groupMenu" :model="groupMenuItems" :min-width="13" @hide="menuGroup = undefined" />
    </div>
</template>

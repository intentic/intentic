<!-- The rail's Personas cut: everyone this sandbox can speak as, in a list that holds still, and the chats of the one picked. -->
<script setup lang="ts">
import { personaBounds } from "@intentic/sandbox-contract";
import { ContextMenu, FACE_SIZES, Icon, PersonaFace, StatusBadge, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, ref, useId, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import { activityIcon, activityLine, agentDisplayTitle, laneOf, standingChip, turnInFlight, unregistered } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { canArchive, FINISHED_WINDOW, type FleetAgent, windowFinished } from "../../agents/fleet/useAgents-fleet";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";
import SandboxOutdatedNotice from "../../sandbox/overview/version/SandboxOutdatedNotice.vue";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import LaneHeader from "../../../components/LaneHeader.vue";
import RailCard from "../../../components/RailCard.vue";
import { relativeTime } from "../models/catalog";
import { previewOf } from "../panel/useChat-strip";
import { useChat } from "../run/useChat";
import type { OpenChat } from "../tabs/cardView";
import ChatRowList from "../tabs/ChatRowList.vue";
import { laneOrdered } from "../tabs/laneOrder";
import { laneOfTab, personaOfAgent, personaOfTab, tabsOfPersona } from "../tabs/tabs";
import { injectChatRowActions } from "../tabs/useChatRowActions";

// WHO STAYS PUT, WHAT THEY SAY CHANGES. The cut used to be an accordion: a persona became a card once it had a chat and
// fell back to a line at the foot once it had none, and every group focus had ever landed in stayed open, remembered
// across reloads, so the reader in one persona's new chat still found another's opened above it. Here every persona
// holds one row in one order whether it has chats or not, one of them is picked, and only its chats are listed below.
// The pick follows focus (a chat started, opened from the board, picked from the list), so the list always lands on
// the chat just brought on screen, and a press on another persona only reads its chats, moving nothing.

const t = useT();
const router = useRouter();

const { personas } = usePersonas();
const { activeId, conversations, tabReveal } = useChat();
const { agentById, fleet, archive, open } = useAgents();
const actions = injectChatRowActions();

// Not-open conversations the list shows before sending the reader to the board for the rest.
const BACKGROUND_SHOWN = 5;
// The key the chats that act as no persona sit under: a persona's id is an entryId, which `*` can never be.
const ANYONE = `*`;

const known = computed(() => new Set(personas.value.map((persona) => persona.id)));

// A sandbox too old to say who a conversation speaks as now (`lastActsAs`) sorts every chat under Anyone. Told by the
// routes its daemon advertises: `agent.switchAccount` arrived in the same release as the field (v1.313), so a daemon
// that lacks the route predates the field too, and one that never said which routes it serves is taken as current
// (useDaemonRoutes). Said only while there is a persona whose chats that hides.
const outdated = computed(() => known.value.size > 0 && !supportsRoute(`agent.switchAccount`));
const keyOf = (persona: string | undefined): string => persona ?? ANYONE;

// Every open chat under exactly one key, the blank a New agent press opened included: it is the chat on screen, and a
// cut that hid it left the reader in a chat the rail showed nowhere.
const openBy = computed(() => {
    const groups = new Map<string, OpenChat[]>();
    for (const conversation of conversations.value) {
        const key = keyOf(personaOfTab(conversation, known.value));
        groups.set(key, [...(groups.get(key) ?? []), { conversation, agent: agentById(conversation.conversationId) }]);
    }
    return groups;
});

// A persona's live conversations this window has not opened: its automations, its other windows' chats, its runs.
const openIds = computed(() => new Set(conversations.value.map((conversation) => conversation.conversationId)));
const LANE_RANK = { attention: 0, active: 1, finished: 2 } as const;
const backgroundBy = computed(() => {
    const groups = new Map<string, FleetAgent[]>();
    for (const agent of fleet.value) {
        const persona = personaOfAgent(agent);
        if (persona === undefined || !known.value.has(persona) || openIds.value.has(agent.id) || agent.sandboxId !== undefined || unregistered(agent.status)) {
            continue;
        }
        groups.set(persona, [...(groups.get(persona) ?? []), agent]);
    }
    for (const [key, agents] of groups) {
        groups.set(key, agents.toSorted((a, b) => LANE_RANK[laneOf(a)] - LANE_RANK[laneOf(b)] || b.updatedAt - a.updatedAt));
    }
    return groups;
});

const working = (entry: OpenChat): boolean =>
    entry.agent !== undefined ? turnInFlight(entry.agent) : entry.conversation.turn.streaming.value;

interface Entry {
    readonly key: string;
    // Undefined for Anyone.
    readonly persona: { id: string; label: string; bounds: string | undefined } | undefined;
    readonly label: string;
    readonly open: readonly OpenChat[];
    readonly background: readonly FleetAgent[];
    // How many chats its list holds, open here or not.
    readonly chats: number;
    readonly needsYou: number;
    readonly working: number;
    // The row's marks in words, for a reader who hears the list rather than sees it: the row is named by the persona
    // alone, and this is its description. Empty when the persona holds nothing.
    readonly facts: string;
}

const entryOf = (key: string, persona: Entry[`persona`], label: string): Entry => {
    const mine = openBy.value.get(key) ?? [];
    const background = persona === undefined ? [] : (backgroundBy.value.get(persona.id) ?? []);
    const chats = mine.length + background.length;
    const needsYou =
        mine.filter((entry) => laneOfTab(entry.conversation, entry.agent) === `attention`).length +
        background.filter((agent) => laneOf(agent) === `attention`).length;
    const busy = mine.filter(working).length + background.filter(turnInFlight).length;
    const facts = [
        needsYou > 0 ? t(`chat.chatPersonaRail.needsYou`, { count: needsYou }, needsYou) : undefined,
        busy > 0 ? t(`chat.chatPersonaRail.working`, { count: busy }, busy) : undefined,
        chats > 0 ? t(`chat.chatPersonaRail.chats`, { count: chats }, chats) : undefined,
    ];
    return {
        key,
        persona,
        label,
        open: mine,
        background,
        chats,
        needsYou,
        working: busy,
        facts: facts.filter((fact) => fact !== undefined).join(`, `),
    };
};

// Anyone first, then every persona in the order personas.json lists them: the order the composer's Acts as menu uses.
const anyone = computed(() => entryOf(ANYONE, undefined, t(`chat.words.anyone`)));
const entries = computed<Entry[]>(() => [
    anyone.value,
    ...personas.value.map((persona) =>
        entryOf(
            persona.id,
            { id: persona.id, label: persona.label ?? persona.id, bounds: persona.powers === undefined ? undefined : personaBounds(persona) },
            persona.label ?? persona.id,
        ),
    ),
]);

// The persona the chat on screen speaks as; Anyone while nothing is.
const focusKey = computed(() => {
    const focused = conversations.value.find((conversation) => conversation.conversationId === activeId.value);
    return focused === undefined ? ANYONE : keyOf(personaOfTab(focused, known.value));
});
// Whose chats are listed: the reader's pick, moved to the focused chat's persona each time focus is asked for (tabReveal
// counts a press on the chat already focused too) and each time that chat's persona changes under it.
const picked = ref(focusKey.value);
watch([activeId, tabReveal, focusKey], () => {
    picked.value = focusKey.value;
});
// A pick naming a persona since deleted reads as Anyone rather than as nothing.
const selected = computed(() => entries.value.find((entry) => entry.key === picked.value) ?? anyone.value);

// Finished chats past the board's window fold, unless the reader lifted it for that persona; pinned ones and the
// focused one always show (windowFinished).
const unfolded = ref<ReadonlySet<string>>(new Set());
const listing = computed(() => {
    const entry = selected.value;
    const lanes = laneOrdered(entry.open);
    const pinned = lanes.finished.filter((chat) => chat.conversation.pinned.value);
    const unpinned = lanes.finished.filter((chat) => !chat.conversation.pinned.value);
    const lifted = unfolded.value.has(entry.key);
    const rest = lifted ? { shown: unpinned, hidden: 0 } : windowFinished(unpinned, activeId.value, (chat) => chat.conversation.conversationId);
    return {
        chats: [...lanes.attention, ...lanes.active, ...pinned, ...rest.shown],
        hidden: rest.hidden,
        lifted: lifted && unpinned.length > FINISHED_WINDOW,
    };
});
const flipped = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (!next.delete(key)) {
        next.add(key);
    }
    return next;
};

// The not-open list: anything waiting on the reader stands in the list itself; the rest waits behind its own fold.
const backgroundShown = ref<ReadonlySet<string>>(new Set());
const waiting = computed(() => selected.value.background.filter((agent) => laneOf(agent) === `attention`));
const quiet = computed(() => selected.value.background.filter((agent) => laneOf(agent) !== `attention`));
const liveOfAgent = (agent: FleetAgent) => ({
    icon: (agent.subagents?.running ?? 0) > 0 ? (`users` as const) : activityIcon(agent.activity?.tool),
    text: activityLine(agent) ?? t(`ui.status.working`),
    since: agent.startedAt,
});
const titleOf = (agent: FleetAgent): string => agentDisplayTitle(agent, previewOf(agent.id));

const startAs = (entry: Entry): void => {
    startAgent(undefined, entry.persona?.id);
};
const newChatLabel = (entry: Entry): string =>
    entry.persona === undefined ? t(`chat.words.newAgent`) : t(`chat.chatPersonaRail.newChatAs`, { label: entry.label });

// A persona's own menu: what can be done to all of its chats at once. Sweeps skip pinned chats (tabsOfPersona).
const groupMenu = ref<{ show: (event: Event) => void } | undefined>();
const menuKey = ref<string>();
const NO_ITEMS: MenuItem[] = [];
const archivableOf = (entry: Entry): string[] => [
    ...entry.open
        .filter(
            (chat) =>
                chat.agent !== undefined && chat.conversation.box.value === undefined && laneOf(chat.agent) === `finished` && canArchive(chat.agent),
        )
        .map((chat) => chat.conversation.conversationId),
    ...entry.background.filter((agent) => laneOf(agent) === `finished` && canArchive(agent)).map((agent) => agent.id),
];
const groupMenuItems = computed<MenuItem[]>(() => {
    const entry = entries.value.find((candidate) => candidate.key === menuKey.value);
    if (entry === undefined) {
        return NO_ITEMS;
    }
    const persona = entry.persona?.id;
    const finished = tabsOfPersona(persona, known.value, `finished`);
    const all = tabsOfPersona(persona, known.value);
    const archivable = archivableOf(entry);
    return [
        { label: newChatLabel(entry), icon: `plus`, command: () => startAs(entry) },
        { separator: true },
        {
            label: t(`chat.chatPersonaRail.closeFinishedOf`, { label: entry.label }),
            disabled: finished.size === 0,
            command: () => actions.closeSet(finished),
        },
        { label: t(`chat.chatPersonaRail.closeAllOf`, { label: entry.label }), disabled: all.size === 0, command: () => actions.closeSet(all) },
        ...(entry.persona === undefined
            ? []
            : [
                  {
                      label: t(`chat.chatPersonaRail.archiveFinishedOf`, { label: entry.label }),
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
const openGroupMenu = (entry: Entry, event: Event): void => {
    menuKey.value = entry.key;
    groupMenu.value?.show(event);
};

// The list starts at its top for a persona just picked, and in either case keeps the focused chat in view.
const scroller = ref<HTMLElement | null>(null);
const reveal = async (fromTop: boolean): Promise<void> => {
    await nextTick();
    if (fromTop && scroller.value !== null) {
        scroller.value.scrollTop = 0;
    }
    scroller.value?.querySelector(`[data-chat-tab="${activeId.value}"]`)?.scrollIntoView({ block: `nearest` });
};
watch(
    () => selected.value.key,
    () => void reveal(true),
);
watch([activeId, tabReveal], () => void reveal(false), { immediate: true });

// A vertical tab list: the arrows, Home and End move the pick and the focus with it; only the picked row is a tab stop.
const uid = useId();
// Distinct prefixes, since a persona may well be called `anyone`; an entryId is a safe id as it stands.
const tabId = (entry: Entry): string => (entry.persona === undefined ? `${uid}-anyone` : `${uid}-persona-${entry.key}`);
const panelId = `${uid}-chats`;
const headingId = `${uid}-heading`;
const STEPS = {
    ArrowDown: (at: number, last: number) => (at === last ? 0 : at + 1),
    ArrowUp: (at: number, last: number) => (at === 0 ? last : at - 1),
    Home: () => 0,
    End: (_at: number, last: number) => last,
} satisfies Record<string, (at: number, last: number) => number>;
const isStep = (key: string): key is keyof typeof STEPS => Object.hasOwn(STEPS, key);
const onTabKey = (event: KeyboardEvent): void => {
    if (!isStep(event.key)) {
        return;
    }
    event.preventDefault();
    const at = STEPS[event.key](entries.value.indexOf(selected.value), entries.value.length - 1);
    const next = entries.value[at] ?? anyone.value;
    picked.value = next.key;
    void nextTick(() => document.getElementById(tabId(next))?.focus());
};
</script>

<template>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <SandboxOutdatedNotice v-if="outdated" :missing="t(`chat.chatPersonaRail.outdatedMissing`)" class="mx-2 mt-2 shrink-0" />

        <!-- The list that holds still: one row per persona whether it has chats or not, so nothing here moves when a chat starts or ends. Capped, so a long roster scrolls in place rather than pushing the chats off the column. -->
        <div class="flex max-h-1/2 shrink-0 flex-col gap-0.5 overflow-y-auto p-2">
            <div role="tablist" aria-orientation="vertical" :aria-label="t(`shared.personas`)" class="flex min-w-0 flex-col gap-0.5" @keydown="onTabKey">
                <button
                    v-for="entry in entries"
                    :id="tabId(entry)"
                    :key="entry.key"
                    type="button"
                    role="tab"
                    :aria-selected="entry.key === selected.key"
                    :aria-controls="panelId"
                    :aria-labelledby="`${tabId(entry)}-name`"
                    :aria-describedby="entry.facts === `` ? undefined : `${tabId(entry)}-facts`"
                    :tabindex="entry.key === selected.key ? 0 : -1"
                    class="ui-row-select group flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 text-left"
                    :class="{ 'ui-row-select-on': entry.key === selected.key }"
                    @click="picked = entry.key"
                    @contextmenu.prevent.stop="openGroupMenu(entry, $event)"
                >
                    <PersonaFace v-if="entry.persona !== undefined" :persona="entry.persona" :size="FACE_SIZES.pill" />
                    <!-- Anyone has no face: the glyph the composer's Acts as menu gives it, on a disc the size of one. -->
                    <span v-else class="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-primary-600/15">
                        <Icon name="users" class="text-2xs text-link" />
                    </span>
                    <span
                        :id="`${tabId(entry)}-name`"
                        class="min-w-0 flex-1 truncate text-xs font-medium"
                        :class="entry.key === selected.key ? 'text-content' : 'text-muted'"
                        >{{ entry.label }}</span
                    >
                    <!-- What needs you and what works, in the marks the chat bar's header uses for the same two facts; then how many chats the list below would hold. -->
                    <span
                        v-if="entry.needsYou > 0"
                        aria-hidden="true"
                        v-tooltip.top="t(`chat.chatPersonaRail.needsYou`, { count: entry.needsYou }, entry.needsYou)"
                        class="ui-status-pill flex shrink-0 items-center gap-1 bg-warning/15 text-2xs font-semibold text-warning"
                    >
                        <Icon name="exclamation-circle" class="text-2xs" />{{ entry.needsYou }}
                    </span>
                    <!-- A spinner without a number: beside the chat count a second figure read as a sum, and how many work is the hover's to say. -->
                    <span
                        v-if="entry.working > 0"
                        aria-hidden="true"
                        v-tooltip.top="t(`chat.chatPersonaRail.working`, { count: entry.working }, entry.working)"
                        class="flex shrink-0 items-center text-link"
                    >
                        <Icon name="spinner" spin class="text-2xs" />
                    </span>
                    <span
                        v-if="entry.chats > 0"
                        aria-hidden="true"
                        v-tooltip.top="t(`chat.chatPersonaRail.chats`, { count: entry.chats }, entry.chats)"
                        class="shrink-0 text-2xs tabular-nums text-subtle"
                        >{{ entry.chats }}</span
                    >
                    <span v-if="entry.facts !== ``" :id="`${tabId(entry)}-facts`" class="sr-only">{{ entry.facts }}</span>
                    <!-- One press to start as anyone on the list, without picking them first; its seat is held at rest, so the counts never shift under the pointer. -->
                    <span
                        role="button"
                        :aria-label="newChatLabel(entry)"
                        v-tooltip.top="newChatLabel(entry)"
                        class="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                        @click.stop="startAs(entry)"
                    >
                        <Icon name="plus" class="text-2xs" />
                    </span>
                </button>
            </div>
            <!-- A real link, since the sandbox hub has an address and this is often the first place someone finds it. -->
            <RouterLink
                to="/sandbox/personas"
                class="ui-row-select flex min-h-7 min-w-0 items-center gap-2 rounded-lg px-1.5 text-2xs text-subtle hover:text-content"
            >
                <span class="flex h-5.5 w-5.5 shrink-0 items-center justify-center">
                    <Icon :name="personas.length === 0 ? `plus` : `cog`" class="text-2xs" />
                </span>
                <span class="min-w-0 truncate">{{ personas.length === 0 ? t(`chat.words.setUpPersona`) : t(`chat.words.managePersonas`) }}</span>
            </RouterLink>
        </div>

        <!-- The picked persona's chats: the very rows the Agents cut draws, so every close, pin, rename and menu is here too, drawn without the trays of agents each one started, since what this cut asks is who a chat speaks as. -->
        <section :id="panelId" role="tabpanel" :aria-labelledby="headingId" class="flex min-h-0 flex-1 flex-col border-t border-line">
            <LaneHeader class="shrink-0 px-3">
                <template #mark>
                    <span :id="headingId" class="min-w-0 truncate text-2xs font-semibold uppercase tracking-wide text-muted">{{ selected.label }}</span>
                    <StatusBadge v-if="selected.persona?.bounds !== undefined" variant="neutral" size="xs">{{ selected.persona.bounds }}</StatusBadge>
                </template>
                <template #actions>
                    <button
                        type="button"
                        :class="ui.iconButton()"
                        :aria-label="newChatLabel(selected)"
                        v-tooltip.bottom="newChatLabel(selected)"
                        @click="startAs(selected)"
                    >
                        <Icon name="plus" class="text-2xs" />
                    </button>
                    <button
                        type="button"
                        :class="ui.iconButton()"
                        :aria-label="t(`chat.chatPersonaRail.more`, { label: selected.label })"
                        v-tooltip.bottom="t(`chat.chatPersonaRail.more`, { label: selected.label })"
                        @click="openGroupMenu(selected, $event)"
                    >
                        <Icon name="ellipsis" class="text-2xs" />
                    </button>
                </template>
            </LaneHeader>

            <div ref="scroller" class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2 pb-2">
                <ChatRowList v-if="listing.chats.length > 0" :entries="listing.chats" :trays="false" />
                <!-- Not a pager: the count itself is the point, one press away rather than gone. -->
                <button
                    v-if="listing.hidden > 0 || listing.lifted"
                    type="button"
                    :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                    @click="unfolded = flipped(unfolded, selected.key)"
                >
                    <Icon :name="listing.lifted ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    {{ listing.lifted ? t(`ui.action.showFewer`) : t(`ui.action.showEarlier`, { count: listing.hidden }) }}
                </button>

                <!-- Waiting on the reader, though not open here: never folded, since a question can't be answered unseen. -->
                <RailCard
                    v-for="agent in waiting"
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
                <template v-if="quiet.length > 0">
                    <button
                        type="button"
                        :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                        :aria-expanded="backgroundShown.has(selected.key)"
                        @click="backgroundShown = flipped(backgroundShown, selected.key)"
                    >
                        <Icon :name="backgroundShown.has(selected.key) ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ t(`chat.chatPersonaRail.notOpen`, { count: quiet.length }, quiet.length) }}
                    </button>
                    <template v-if="backgroundShown.has(selected.key)">
                        <RailCard
                            v-for="agent in quiet.slice(0, BACKGROUND_SHOWN)"
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
                        <RouterLink v-if="quiet.length > BACKGROUND_SHOWN" to="/agents" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)">
                            {{ t(`chat.chatPersonaRail.moreOnBoard`, { count: quiet.length - BACKGROUND_SHOWN }) }}
                        </RouterLink>
                    </template>
                </template>

                <!-- Someone with nothing to show yet still offers the one next step. -->
                <button
                    v-if="selected.open.length === 0 && selected.background.length === 0"
                    type="button"
                    :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                    @click="startAs(selected)"
                >
                    <Icon name="plus" class="text-2xs" />
                    {{ newChatLabel(selected) }}
                </button>
            </div>
        </section>
        <ContextMenu ref="groupMenu" :model="groupMenuItems" :min-width="13" @hide="menuKey = undefined" />
    </div>
</template>

<!-- The rail's Personas cut: everyone this sandbox can speak as, in a list that holds still, and the chats of the one picked. -->
<script setup lang="ts">
import { personaBounds } from "@intentic/sandbox-contract";
import { Button, ContextMenu, FACE_SIZES, Icon, PersonaFace, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, watchEffect } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import { activityIcon, activityLine, agentDisplayTitle, laneOf, standingChip, turnInFlight, unregistered } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { canArchive, FINISHED_WINDOW, type FleetAgent, windowFinished } from "../../agents/fleet/useAgents-fleet";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";
import SandboxOutdatedNotice from "../../sandbox/overview/version/SandboxOutdatedNotice.vue";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import RailCard from "../../../components/RailCard.vue";
import { relativeTime } from "../models/catalog";
import { previewOf } from "../panel/useChat-strip";
import { useChat } from "../run/useChat";
import { railPersona } from "./railPersona";
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
// Said to the rail's foot, whose New agent press then starts as this persona too (railPersona).
watchEffect(() => {
    const persona = selected.value.persona;
    railPersona.value = persona === undefined ? undefined : { id: persona.id, label: persona.label };
});
onBeforeUnmount(() => {
    railPersona.value = undefined;
});

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
// Its hover: the row or header beside it already names the persona, so two words say the rest.
const newChatTip = (entry: Entry): string => (entry.persona === undefined ? t(`chat.words.newAgent`) : t(`chat.words.newChat`));

// The one sweep kept above the list: the tiles already name whose chats these are and the composer below starts one,
// so a header bar only repeated them. Counted off the set the press sends, so the label can't name a number it doesn't close.
const finishedOfSelected = computed(() => tabsOfPersona(selected.value.persona?.id, known.value, `finished`));

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
        { separator: true },
        { label: t(`chat.words.managePersonas`), icon: `users`, command: () => void router.push(`/sandbox/personas`) },
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

// A grid of tabs: Left and Right step one tile, Up and Down a row, Home and End to either end, each moving the pick and
// the focus with it; only the picked tile is a tab stop. The row length is read off the laid-out grid, since it follows
// the column's width; unlaid (a test's DOM) it reads as one, so Up and Down step a tile.
const grid = ref<HTMLElement | null>(null);
const columns = (): number => {
    const template = grid.value === null ? `` : getComputedStyle(grid.value).gridTemplateColumns;
    return Math.max(1, template.split(` `).filter((track) => track !== `` && track !== `none`).length);
};
const uid = useId();
// Distinct prefixes, since a persona may well be called `anyone`; an entryId is a safe id as it stands.
const tabId = (entry: Entry): string => (entry.persona === undefined ? `${uid}-anyone` : `${uid}-persona-${entry.key}`);
const panelId = `${uid}-chats`;
const next = (at: number, last: number): number => (at === last ? 0 : at + 1);
const previous = (at: number, last: number): number => (at === 0 ? last : at - 1);
// A row step off either edge lands on the first or last tile rather than wrapping into a column that may be short.
const STEPS = {
    ArrowRight: next,
    ArrowLeft: previous,
    ArrowDown: (at: number, last: number) => (at === last ? 0 : Math.min(last, at + columns())),
    ArrowUp: (at: number, last: number) => (at === 0 ? last : Math.max(0, at - columns())),
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
    const target = entries.value[at] ?? anyone.value;
    picked.value = target.key;
    void nextTick(() => document.getElementById(tabId(target))?.focus());
};
</script>

<template>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <SandboxOutdatedNotice v-if="outdated" :missing="t(`chat.chatPersonaRail.outdatedMissing`)" class="mx-2 mt-2 shrink-0" />

        <!-- The grid that holds still: one tile per persona whether it has chats or not, so nothing here moves when a chat starts or ends. Tiles rather than rows, so a face is big enough to be the thing recognised. Capped, so a long roster scrolls in place rather than pushing the chats off the column. -->
        <div class="max-h-1/2 shrink-0 overflow-y-auto p-2">
            <div
                ref="grid"
                role="tablist"
                :aria-label="t(`shared.personas`)"
                class="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-1"
                @keydown="onTabKey"
            >
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
                    v-tooltip.bottom="entry.persona?.bounds"
                    class="ui-row-select group relative flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 pb-1.5 pt-2.5"
                    :class="{ 'ui-row-select-on': entry.key === selected.key }"
                    @click="picked = entry.key"
                    @contextmenu.prevent.stop="openGroupMenu(entry, $event)"
                >
                    <PersonaFace v-if="entry.persona !== undefined" :persona="entry.persona" :size="FACE_SIZES.card" />
                    <!-- Anyone has no face: the glyph the composer's Acts as menu gives it, on a disc the size of one. -->
                    <span v-else class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-600/15">
                        <Icon name="users" class="text-lg text-link" />
                    </span>
                    <span
                        :id="`${tabId(entry)}-name`"
                        class="line-clamp-2 w-full min-w-0 break-words text-center text-xs font-medium leading-tight"
                        :class="entry.key === selected.key ? 'text-content' : 'text-muted'"
                        >{{ entry.label }}</span
                    >
                    <!-- What needs you, what works and how many chats the list below would hold, in the marks the chat bar's header uses; a seat held even when empty, so tiles in a row keep one height. -->
                    <span aria-hidden="true" class="flex h-4 items-center justify-center gap-1.5">
                        <span
                            v-if="entry.needsYou > 0"
                            v-tooltip.top="t(`agents.agentStatus.needsYou`)"
                            class="ui-status-pill flex shrink-0 items-center gap-1 bg-warning/15 text-2xs font-semibold text-warning"
                        >
                            <Icon name="exclamation-circle" class="text-2xs" />{{ entry.needsYou }}
                        </span>
                        <!-- A spinner without a number: beside the chat count a second figure read as a sum, and how many work is the hover's to say. -->
                        <span
                            v-if="entry.working > 0"
                            v-tooltip.top="t(`chat.chatPersonaRail.working`, { count: entry.working }, entry.working)"
                            class="flex shrink-0 items-center text-link"
                        >
                            <Icon name="spinner" spin class="text-2xs" />
                        </span>
                        <span
                            v-if="entry.chats > 0"
                            v-tooltip.top="t(`chat.chatPersonaRail.chats`, { count: entry.chats }, entry.chats)"
                            class="shrink-0 text-2xs tabular-nums text-subtle"
                            >{{ entry.chats }}</span
                        >
                    </span>
                    <span v-if="entry.facts !== ``" :id="`${tabId(entry)}-facts`" class="sr-only">{{ entry.facts }}</span>
                    <!-- One press to start as anyone here, without picking them first: in the tile's corner, shown on hover. -->
                    <span
                        role="button"
                        :aria-label="newChatLabel(entry)"
                        v-tooltip.top="newChatTip(entry)"
                        class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                        @click.stop="startAs(entry)"
                    >
                        <Icon name="plus" class="text-2xs" />
                    </span>
                </button>
                <!-- Nobody to pick yet: the one door to making someone. Once there are personas, their page is in each tile's menu. -->
                <RouterLink
                    v-if="personas.length === 0"
                    to="/sandbox/personas"
                    class="ui-row-select flex min-w-0 flex-col items-center gap-1 rounded-lg border border-dashed border-line px-1 pb-1.5 pt-2.5 text-subtle hover:text-content"
                >
                    <span class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full">
                        <Icon name="plus" class="text-lg" />
                    </span>
                    <span class="w-full min-w-0 truncate text-center text-xs">{{ t(`chat.words.setUpPersona`) }}</span>
                </RouterLink>
            </div>
        </div>

        <!-- The picked persona's chats: the very rows the Agents cut draws, so every close, pin, rename and menu is here too, drawn without the trays of agents each one started, since what this cut asks is who a chat speaks as. Named by the picked tile, which says whose they are. -->
        <section :id="panelId" role="tabpanel" :aria-labelledby="`${tabId(selected)}-name`" class="flex min-h-0 flex-1 flex-col">

            <div ref="scroller" class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2">
                <ChatRowList v-if="listing.chats.length > 0" :entries="listing.chats" :trays="false" />
                <!-- The list's foot: the fold over older finished chats, and the one sweep for them beside it, so the chats sit straight under the grid and the sweep under what it closes. -->
                <div v-if="listing.hidden > 0 || listing.lifted || finishedOfSelected.size > 0" class="flex min-w-0 items-center justify-end gap-2">
                    <!-- Not a pager: the count itself is the point, one press away rather than gone. -->
                    <button
                        v-if="listing.hidden > 0 || listing.lifted"
                        type="button"
                        :class="ui.addTile(`min-w-0 flex-1 gap-1 rounded-lg py-1.5 text-2xs`)"
                        @click="unfolded = flipped(unfolded, selected.key)"
                    >
                        <Icon :name="listing.lifted ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ listing.lifted ? t(`ui.action.showFewer`) : t(`ui.action.showEarlier`, { count: listing.hidden }) }}
                    </button>
                    <Button
                        v-if="finishedOfSelected.size > 0"
                        class="shrink-0"
                        size="small"
                        severity="secondary"
                        :text="true"
                        :aria-label="t(`chat.chatTabList.clearFinished`, { count: finishedOfSelected.size }, finishedOfSelected.size)"
                        v-tooltip.top="{
                            title: t(`chat.chatPersonaRail.closeFinishedOf`, { label: selected.label }),
                            rows: [{ label: t(`chat.chatTabList.chats`), value: finishedOfSelected.size }],
                            note: t(`chat.chatTabList.keepsFinished`),
                        }"
                        @click="actions.closeSet(finishedOfSelected)"
                    >
                        {{ t(`ui.action.clear`) }}
                    </Button>
                </div>

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

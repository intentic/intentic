<!-- The chat list's scope: Anyone, then everyone this sandbox can speak as, in a grid that holds still. Picking a tile narrows the lanes below to that persona's chats (usePersonaScope). -->
<script setup lang="ts">
import { personaBounds } from "@intentic/sandbox-contract";
import { ContextMenu, FACE_SIZES, Icon, PersonaFace } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, ref, useId } from "vue";
import { useRouter } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import { laneOf, turnInFlight } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { canArchive } from "../../agents/fleet/useAgents-fleet";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";
import SandboxOutdatedNotice from "../../sandbox/overview/version/SandboxOutdatedNotice.vue";
import { useChat } from "../run/useChat";
import { laneOfTab, tabsOfPersona } from "../tabs/tabs";
import { injectChatRowActions } from "../tabs/useChatRowActions";
import { usePersonaScope } from "./usePersonaScope";

// WHO STAYS PUT, WHAT THEY SAY CHANGES: one tile per persona in personas.json's order whether it has chats or not, so
// nothing here moves when a chat starts or ends. Tiles rather than rows, so a face is big enough to be what's recognised.

const props = defineProps<{
    // The list the tiles scope, for aria-controls.
    controls: string;
}>();

const t = useT();
const router = useRouter();
const { conversations } = useChat();
const { agentById, archive } = useAgents();
const actions = injectChatRowActions();
const { personas, known, scope, pick, listedUnder, notOpenOf, liveNotOpenOf } = usePersonaScope();

// A sandbox too old to say who a conversation speaks as now (`lastActsAs`) scopes every chat out of every persona. Told
// by the routes its daemon advertises: `agent.switchAccount` arrived in the same release as the field (v1.313), so a
// daemon that lacks the route predates the field too, and one that never said which routes it serves is taken as
// current (useDaemonRoutes).
const outdated = computed(() => !supportsRoute(`agent.switchAccount`));

interface Tile {
    // Undefined for Anyone.
    readonly persona: { id: string; label: string; bounds: string | undefined } | undefined;
    readonly label: string;
    // What the lanes would list under this tile, open here or not.
    readonly chats: number;
    readonly needsYou: number;
    readonly working: number;
    // The tile's marks in words, for a reader who hears the grid rather than sees it: the tile is named by the persona
    // alone, and this is its description. Empty when it holds nothing.
    readonly facts: string;
}

const tileOf = (persona: Tile[`persona`], label: string): Tile => {
    const mine = conversations.value
        .filter((conversation) => listedUnder(conversation, persona?.id))
        .map((conversation) => ({ conversation, agent: agentById(conversation.conversationId) }));
    const background = liveNotOpenOf(persona?.id);
    const chats = mine.length + background.length;
    const needsYou =
        mine.filter((entry) => laneOfTab(entry.conversation, entry.agent) === `attention`).length +
        background.filter((agent) => laneOf(agent) === `attention`).length;
    const working =
        mine.filter((entry) => (entry.agent !== undefined ? turnInFlight(entry.agent) : entry.conversation.turn.streaming.value)).length +
        background.filter(turnInFlight).length;
    const facts = [
        needsYou > 0 ? t(`chat.chatPersonaRail.needsYou`, { count: needsYou }, needsYou) : undefined,
        working > 0 ? t(`chat.chatPersonaRail.working`, { count: working }, working) : undefined,
        chats > 0 ? t(`chat.chatPersonaRail.chats`, { count: chats }, chats) : undefined,
    ];
    return { persona, label, chats, needsYou, working, facts: facts.filter((fact) => fact !== undefined).join(`, `) };
};

// Anyone first, then every persona in the order personas.json lists them: the order the composer's Acts as menu uses.
const tiles = computed<Tile[]>(() => [
    tileOf(undefined, t(`chat.words.anyone`)),
    ...personas.value.map((persona) =>
        tileOf(
            { id: persona.id, label: persona.label ?? persona.id, bounds: persona.powers === undefined ? undefined : personaBounds(persona) },
            persona.label ?? persona.id,
        ),
    ),
]);
// Anyone's tile face: up to three personas' faces huddled into one card-sized box, back pair first, front one last.
const HUDDLE_FACE = 40;
const huddle = computed(() => personas.value.slice(0, 3).map((persona) => ({ id: persona.id, label: persona.label ?? persona.id })));
const huddleSpot = (index: number, count: number): Record<string, string> => {
    const spots: readonly (readonly [number, number])[] =
        count === 1 ? [[12, 12]] : count === 2 ? [[1, 6], [23, 18]] : [[0, 3], [24, 3], [12, 24]];
    const [left, top] = spots[index]!;
    return { left: `${left}px`, top: `${top}px`, zIndex: `${index}` };
};
// The hover says what the tile holds, then what the persona may do.
const tileTip = (tile: Tile): string | undefined => [tile.facts, tile.persona?.bounds].filter((line) => line !== undefined && line !== ``).join(`\n`) || undefined;
const isPicked = (tile: Tile): boolean => tile.persona?.id === scope.value?.id;
const selected = computed(() => tiles.value.find(isPicked) ?? tiles.value[0]!);

// A tile's "+" starts as that persona and scopes the list to them, so the new chat lands among its own.
const startAs = (tile: Tile): void => {
    pick(tile.persona?.id);
    startAgent(undefined, tile.persona?.id);
};
const newChatLabel = (tile: Tile): string =>
    tile.persona === undefined ? t(`chat.words.newAgent`) : t(`chat.chatPersonaRail.newChatAs`, { label: tile.label });
// Its hover: the tile beside it already names the persona, so two words say the rest.
const newChatTip = (tile: Tile): string => (tile.persona === undefined ? t(`chat.words.newAgent`) : t(`chat.words.newChat`));

// A persona's own menu: what can be done to all of its chats at once, and its page. Sweeps skip pinned chats
// (tabsOfPersona). Anyone's is short: the lanes' own Clear already sweeps every chat.
const menu = ref<{ show: (event: Event) => void } | undefined>();
const menuTile = ref<Tile>();
const archivableOf = (persona: string): string[] => [
    ...conversations.value
        .filter((conversation) => listedUnder(conversation, persona) && conversation.box.value === undefined)
        .map((conversation) => agentById(conversation.conversationId))
        .filter((agent) => agent !== undefined && laneOf(agent) === `finished` && canArchive(agent))
        .map((agent) => agent!.id),
    ...notOpenOf(persona)
        .filter((agent) => laneOf(agent) === `finished` && canArchive(agent))
        .map((agent) => agent.id),
];
const manage: MenuItem = { label: t(`chat.words.managePersonas`), icon: `users`, command: () => void router.push(`/sandbox/personas`) };
const menuItems = computed<MenuItem[]>(() => {
    const tile = menuTile.value;
    if (tile === undefined) {
        return [];
    }
    const start: MenuItem = { label: newChatLabel(tile), icon: `plus`, command: () => startAs(tile) };
    if (tile.persona === undefined) {
        return [start, { separator: true }, manage];
    }
    const persona = tile.persona.id;
    const finished = tabsOfPersona(persona, known.value, `finished`);
    const all = tabsOfPersona(persona, known.value);
    const archivable = archivableOf(persona);
    return [
        start,
        { separator: true },
        { label: t(`chat.chatPersonaRail.closeFinishedOf`, { label: tile.label }), disabled: finished.size === 0, command: () => actions.closeSet(finished) },
        { label: t(`chat.chatPersonaRail.closeAllOf`, { label: tile.label }), disabled: all.size === 0, command: () => actions.closeSet(all) },
        {
            label: t(`chat.chatPersonaRail.archiveFinishedOf`, { label: tile.label }),
            icon: `box`,
            disabled: archivable.length === 0,
            command: () => void archive(archivable),
        },
        { separator: true },
        { label: t(`chat.chatPersonaRail.editPersona`), icon: `cog`, command: () => void router.push({ path: `/sandbox/personas`, query: { open: persona } }) },
        manage,
    ];
});
const openMenu = (tile: Tile, event: Event): void => {
    menuTile.value = tile;
    menu.value?.show(event);
};

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
const tabId = (tile: Tile): string => (tile.persona === undefined ? `${uid}-anyone` : `${uid}-persona-${tile.persona.id}`);
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
const onKey = (event: KeyboardEvent): void => {
    if (!isStep(event.key)) {
        return;
    }
    event.preventDefault();
    const at = STEPS[event.key](tiles.value.indexOf(selected.value), tiles.value.length - 1);
    const target = tiles.value[at] ?? tiles.value[0]!;
    pick(target.persona?.id);
    void nextTick(() => document.getElementById(tabId(target))?.focus());
};

// The list below names itself by the picked tile.
defineExpose({ selectedTabId: computed(() => `${tabId(selected.value)}-name`) });
</script>

<template>
    <div class="flex min-w-0 shrink-0 flex-col gap-1.5">
        <SandboxOutdatedNotice v-if="outdated" :missing="t(`chat.chatPersonaRail.outdatedMissing`)" class="shrink-0" />
        <!-- Capped, so a long roster scrolls in place rather than pushing the chats off the column. auto-fit, so a short roster spreads over the column's width rather than leaving empty tracks on the right. -->
        <div
            ref="grid"
            role="tablist"
            :aria-label="t(`shared.personas`)"
            class="grid max-h-[40vh] min-w-0 grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-1 overflow-y-auto"
            @keydown="onKey"
        >
            <button
                v-for="tile in tiles"
                :id="tabId(tile)"
                :key="tabId(tile)"
                type="button"
                role="tab"
                :aria-selected="tile === selected"
                :aria-controls="props.controls"
                :aria-labelledby="`${tabId(tile)}-name`"
                :aria-describedby="tile.facts === `` ? undefined : `${tabId(tile)}-facts`"
                :tabindex="tile === selected ? 0 : -1"
                v-tooltip.bottom="tileTip(tile)"
                class="ui-row-select ui-row-select-horizontal group relative flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 pb-1.5 pt-2.5"
                :class="{ 'ui-row-select-on': tile === selected }"
                @click="pick(tile.persona?.id)"
                @contextmenu.prevent.stop="openMenu(tile, $event)"
            >
                <!-- What needs you and what works ride on the face as badges, where a glance lands anyway; the chat count is the hover's. -->
                <span class="relative shrink-0">
                    <PersonaFace v-if="tile.persona !== undefined" :persona="tile.persona" :size="FACE_SIZES.card" />
                    <!-- Anyone is everyone here: a huddle of the first few companions beside it. -->
                    <span v-else-if="huddle.length > 0" class="relative block h-16 w-16" aria-hidden="true">
                        <PersonaFace
                            v-for="(face, index) in huddle"
                            :key="face.id"
                            :persona="face"
                            :size="HUDDLE_FACE"
                            class="absolute"
                            :style="huddleSpot(index, huddle.length)"
                        />
                    </span>
                    <!-- No personas yet: the glyph the composer's Acts as menu gives Anyone, on a disc the size of a face. -->
                    <span v-else class="flex h-16 w-16 items-center justify-center rounded-full bg-primary-600/15">
                        <Icon name="users" class="text-lg text-link" />
                    </span>
                    <span
                        v-if="tile.needsYou > 0"
                        aria-hidden="true"
                        class="absolute -right-1 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-2xs font-semibold tabular-nums leading-none text-canvas ring-2 ring-canvas"
                        >{{ tile.needsYou }}</span
                    >
                    <span
                        v-if="tile.working > 0"
                        aria-hidden="true"
                        class="absolute -bottom-0.5 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-canvas text-link ring-2 ring-canvas"
                    >
                        <Icon name="spinner" spin class="text-2xs" />
                    </span>
                </span>
                <span
                    :id="`${tabId(tile)}-name`"
                    class="line-clamp-2 w-full min-w-0 break-words text-center text-xs font-medium leading-tight"
                    :class="tile === selected ? 'text-content' : 'text-muted'"
                    >{{ tile.label }}</span
                >
                <span v-if="tile.facts !== ``" :id="`${tabId(tile)}-facts`" class="sr-only">{{ tile.facts }}</span>
                <!-- One press to start as anyone here, without picking them first: in the tile's corner, shown on hover. -->
                <span
                    role="button"
                    :aria-label="newChatLabel(tile)"
                    v-tooltip.top="newChatTip(tile)"
                    class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                    @click.stop="startAs(tile)"
                >
                    <Icon name="plus" class="text-2xs" />
                </span>
            </button>
        </div>
        <ContextMenu ref="menu" :model="menuItems" :min-width="13" @hide="menuTile = undefined" />
    </div>
</template>

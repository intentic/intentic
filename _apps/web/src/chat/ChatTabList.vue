<script setup lang="ts">
import { ContextMenu, type IconName } from "@intentic-app/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createTitleEdit } from "../composables/agents/titleEdit";
import {
    activityIcon,
    agentStatusMeta,
    attentionReason,
    type FleetLane,
    formatCost,
    formatElapsed,
    turnInFlight,
} from "../composables/agents/agentStatus";
import { markSegments, useAgentFilter } from "../composables/agents/useAgentFilter";
import { type FleetAgent, useAgents } from "../composables/agents/useAgents";
import FilterField from "../components/FilterField.vue";
import HoverCard from "../components/HoverCard.vue";
import OriginMark from "../components/OriginMark.vue";
import { relativeTime, statusIcon, statusLabel } from "../composables/chat/catalog";
import type { Conversation } from "../composables/chat/conversation";
import { modelLabelFor } from "../composables/chat/providerCatalog";
import { allTabs, finishedTabs, isArchived, laneOfTab, originOf, othersOf, tabLabel, toRightOf } from "../composables/chat/tabs";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { commandShortcut } from "../composables/commands/useCommands";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";
import ProviderLogo from "./ProviderLogo.vue";
import { providerLabel } from "@intentic/sandbox-contract";

/* THE OPEN CHATS, as the fleet board's three lanes in miniature — the switcher for every conversation this
 * window holds. It has two hosts and is the same list in both: the sheet the docked panel's header drops
 * (ChatTabs), and the rail down the left edge of a popped-out window. It used to be rail-only, while the
 * docked panel wore a row of pill tabs that wrapped to a second line — a strictly worse switcher (a dot and
 * ~28 characters of a title, in rows that reflowed on every open and close) built out of a second set of
 * components. One list, two frames.
 *
 * Each card is the chat it always was — click selects, double-click renames, right-click menus, × closes —
 * wearing the crucial slice of its /agents card: status glyph on the title row, two lines of title, cost /
 * diff / elapsed, and the live activity line. Cards carry the BOARD's skin (a bordered surface, AgentCard's)
 * rather than a transparent pill: a pill disappears into a column of pills, and "which sessions do I have"
 * is this list's first job. Colour is spent the way the board spends it — status lives in the glyph and the
 * semantic chips; the title, the numbers and the activity line stay neutral, so the accent colour means
 * something when it does appear (the attention chip, a diff, an error).
 *
 * The list reads the stores and emits verbs rather than writing them: the panel that hosts it is what hands
 * each verb to useChat, exactly as the strip always did. */

const emit = defineEmits<{
    select: [id: string];
    // A SET, not an id: a card's × closes one, the right-click menu's Close Others / to the Right / All close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, tabReveal } = useChat();
const { agentById, fleet, loadArchived } = useAgents();
const { poppedOut, toggle: togglePopout, overlayTarget } = useChatPopout();

interface OpenChat {
    readonly conversation: Conversation;
    readonly agent: FleetAgent | undefined;
}
const lastActive = (entry: OpenChat): number => entry.agent?.updatedAt ?? 0;

/* --- The filter -------------------------------------------------------------------------------
 * The same field, the same rule and the same evidence as the fleet board's (useAgentFilter): match what the
 * USER wrote — the title, which is their sanitized first prompt, and every later prompt in the transcript.
 * Two search boxes in one product that disagree about what "matches" means is worse than one of them not
 * existing, so both mount the one composable rather than each rolling its own.
 *
 * What differs is the SET. The board filters the fleet; this list holds the OPEN chats, which is a much
 * smaller thing to be looking through — a user asking "where did I say X" is almost never asking only about
 * the eight chats they happen to have open. So the query reaches the whole fleet here too, and everything it
 * finds that ISN'T open lands in a group below the lanes that opens on click. The History popover keeps its
 * own box for browsing; this one is for finding.
 *
 * Its state is per-INSTANCE, which means per-window and per-opening: a query typed on the board must not
 * narrow a pop-out the user isn't looking at.
 */
const {
    query: filterQuery,
    needle,
    active: filtering,
    matches: agentMatches,
    snippetOf,
    archivedMatches,
    sessionMatches,
    searching,
} = useAgentFilter();

// A chat with no fleet entry (a plain conversation, or the roster briefly down) has no transcript the daemon
// can search under an agent id, so it is matched on what this browser holds: its title and its own messages.
const tabMatches = (entry: OpenChat): boolean => {
    if (!filtering.value) {
        return true;
    }
    if (entry.agent !== undefined) {
        return agentMatches(entry.agent);
    }
    const title = entry.conversation.title.value;
    return (
        title?.toLowerCase().includes(needle.value) === true ||
        entry.conversation.messages.value.some((message) => message.role === `user` && message.text.toLowerCase().includes(needle.value))
    );
};

const lanes = computed<Record<FleetLane, OpenChat[]>>(() => {
    const grouped: Record<FleetLane, OpenChat[]> = { attention: [], active: [], finished: [] };
    for (const conversation of conversations.value) {
        const agent = agentById(conversation.conversationId);
        grouped[laneOfTab(conversation, agent)].push({ conversation, agent });
    }
    // The board's own orderings (useAgents.lanes): fresh drafts lead Active, then turn start — fixed for the
    // turn's life, so a running card holds its slot; the other two lanes read newest-first.
    grouped.active.sort(
        (a, b) =>
            Number(b.agent?.status === `draft`) - Number(a.agent?.status === `draft`) ||
            (a.agent?.startedAt ?? lastActive(a)) - (b.agent?.startedAt ?? lastActive(b)),
    );
    grouped.attention.sort((a, b) => lastActive(b) - lastActive(a));
    grouped.finished.sort((a, b) => lastActive(b) - lastActive(a));
    return grouped;
});
const LANES: readonly { key: FleetLane; label: string; dot: string }[] = [
    { key: `attention`, label: `Attention`, dot: `bg-warning` },
    { key: `active`, label: `Active`, dot: `bg-success` },
    { key: `finished`, label: `Finished`, dot: `bg-line-strong` },
];

// A lane's visible chats, and how many of its own it is showing. Same `n of m` the board's lane headers carry,
// for the same reason: a lane that silently shrinks is a lane that has stopped saying anything.
const cardsIn = (lane: FleetLane): OpenChat[] => lanes.value[lane].filter(tabMatches);
const countIn = (lane: FleetLane): string =>
    filtering.value ? `${cardsIn(lane).length} of ${lanes.value[lane].length}` : String(lanes.value[lane].length);

// The card's status glyph, worn ON THE TITLE ROW — status is the first question this list answers, so it
// doesn't belong buried in the numbers line. Fleet-carded chats read the agent's own status (the richer
// machine: landed, conflict…); a plain chat degrades to what its conversation is doing right now, through the
// same statusIcon the panel's header draws.
const statusOf = (entry: OpenChat): { icon: IconName; spin?: boolean; label: string; class: string } => {
    if (entry.agent !== undefined) {
        const meta = agentStatusMeta(entry.agent.status);
        return { ...meta, class: `text-2xs ${meta.class}` };
    }
    const status = entry.conversation.status.value;
    const icon = statusIcon(status);
    return { icon: icon.name, spin: icon.spin, label: statusLabel(status), class: icon.class };
};

/* TWO FACTS THE CARD SHOWS AS A MARK RATHER THAN A LINE — their words ride the card's hover preview.
 * The model: the provider glyph already carries it, and a fleet is usually one model deep, so the name was a
 * column of identical text down the list. What the turn is doing right now: the glyph says "it is working",
 * which is the actionable half — the command itself was the noisiest, least stable line on a card (a path that
 * changes every few seconds), and it cost a whole row of a list whose cards are read as a stack.
 *
 * They used to be two `v-tooltip`s on two glyphs INSIDE a card that already opens a HoverCard on the same
 * hover — three boxes for one pointer, two of them landing in the card the third had just claimed. This is
 * what HoverCard.note is for, and what the Changes panel's chips already do with it. */
const noteOf = (agent: FleetAgent | undefined): string | undefined => {
    if (agent === undefined) {
        return undefined;
    }
    const model = agent.model !== undefined ? modelLabelFor(agent.provider, agent.model) : providerLabel(agent.provider);
    const doing =
        agent.activity === undefined ? undefined : (agent.activity.todo ?? [agent.activity.tool, agent.activity.target].filter(Boolean).join(` `));
    return [model, doing].filter((part) => part !== undefined && part !== ``).join(` · `);
};

/* What the query found that ISN'T open in this window — the whole point of the filter reaching past its own
 * list. Live fleet agents first (the likeliest thing to want), then the archive, each as a row that opens the
 * conversation. Conversations no agent owns come from `sessionMatches` and open the same way.
 *
 * The archive is off the live roster, so its contents have to be asked for; the board does that at mount, but
 * a user who never opened /agents has no reason to have paid for it. Asked for once, the first time a query
 * is typed here.
 */
const openIds = computed(() => new Set(conversations.value.map((conversation) => conversation.conversationId)));
const notOpen = computed<FleetAgent[]>(() => {
    if (!filtering.value) {
        return [];
    }
    return [...fleet.value.filter((agent) => agentMatches(agent)), ...archivedMatches.value].filter((agent) => !openIds.value.has(agent.id));
});
const notOpenCount = computed(() => notOpen.value.length + sessionMatches.value.length);

let archiveAsked = false;
watch(filtering, (on) => {
    if (on && !archiveAsked) {
        archiveAsked = true;
        void loadArchived();
    }
});

// One second ticks every running card's elapsed readout together (the board's `now` pattern) — armed while
// this list is on screen, which for the docked sheet means only while it is open.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    ticker = setInterval(() => {
        now.value = Date.now();
    }, 1000);
});
onBeforeUnmount(() => clearInterval(ticker));

/* --- Keeping the active card in view ------------------------------------------------------------
 * The list scrolls, and the chat it is pointing at is almost always selected from somewhere else — a card on
 * the fleet board, a history row, Alt+PageUp/Down, a brand-new agent appended to the end. A list that opens
 * scrolled past the card it is highlighting reads as one that lost your place. `nearest` moves the least it
 * can and no-ops on a card already visible, so clicking a card in the list never shifts it under the pointer.
 *
 * Two triggers, because the id is not the whole story: activeId covers a focus that MOVED, and the store's
 * tabReveal counter covers a focus asked for again (the board card of the chat you are already in, clicked
 * while this list is scrolled elsewhere). `immediate` covers the third case, which is the docked one: the
 * sheet mounts on open, and the card it must show is whichever was already active. */
const scroller = ref<HTMLElement | null>(null);
watch(
    [activeId, tabReveal],
    async () => {
        await nextTick();
        scroller.value?.querySelector(`[data-chat-tab="${activeId.value}"]`)?.scrollIntoView({ block: `nearest` });
    },
    { immediate: true },
);

/* --- Inline rename ------------------------------------------------------------------------------
 * One edit state for the whole list (only one card renames at a time), pointed at a card by `renamingId`. The
 * write goes through the same createTitleEdit the fleet cards use, so a chat renamed here renames the agent
 * registry entry too — the card here and the card on /agents are one thing under two skins. Reached by
 * double-clicking a card or through its menu; F2 is the panel header's, and renames the ACTIVE chat there. */
const renamingId = ref<string | undefined>(undefined);
const renaming = computed(() => conversations.value.find((conversation) => conversation.conversationId === renamingId.value));
const edit = createTitleEdit(
    () => renaming.value?.conversationId ?? ``,
    () => renaming.value?.title.value ?? undefined,
);
const beginRename = (id: string): void => {
    renamingId.value = id;
    edit.begin();
};
// F2 in a POPPED-OUT window has no header to rename in — the rail is the whole surface out there — so the host
// hands the press down to the card it names. Docked, the header renames itself and never calls this.
defineExpose({ beginRename });

// --- Hover preview --------------------------------------------------------------------------------
// A card clamps its title to two lines, on top of the 40-char derivation, so hovering reveals the FULL derived
// title and, under it, the first message that title was derived from. The card itself is the shared HoverCard
// — the Changes panel's agent chips raise the same one for the same session.
const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
const showPreview = (event: MouseEvent, conversation: Conversation, agent?: FleetAgent): void => {
    const firstUser = conversation.messages.value.find((message) => message.role === `user`);
    // A fresh "New chat"/"New agent" card has neither, and the preview declines to open on empty content.
    hoverCard.value?.show(event, { title: conversation.title.value ?? undefined, note: noteOf(agent), body: firstUser?.text });
};
const hidePreview = (): void => {
    hoverCard.value?.hide();
};

/* --- Right-click menu -----------------------------------------------------------------------------
 * The same close set the workspace's file tabs carry, plus this list's own rename and the pop-out toggle. It
 * acts on the RIGHT-CLICKED card (`menuTabId`), never on the active one — the split the workspace makes, and
 * the reason the keyboard commands (which act on the active chat) live with the header rather than here. */
const tabMenu = ref<{ show: (event: Event) => void } | undefined>();
const menuTabId = ref<string>();

const tabMenuItems = computed<MenuItem[]>(() => {
    const id = menuTabId.value;
    if (id === undefined || !conversations.value.some((conversation) => conversation.conversationId === id)) {
        return []; // no card named, or the right-clicked one closed under the open menu
    }
    const others = othersOf(id);
    const toRight = toRightOf(id);
    const finished = finishedTabs();
    return [
        { label: `Rename`, icon: `pencil`, shortcut: commandShortcut(`chat.rename`), command: () => beginRename(id) },
        { separator: true },
        { label: `Close`, icon: `times`, shortcut: commandShortcut(`chat.closeTab`), command: () => emit(`close`, new Set([id])) },
        {
            label: `Close Others`,
            disabled: others.size === 0,
            shortcut: commandShortcut(`chat.closeOtherTabs`),
            command: () => emit(`close`, others),
        },
        {
            label: `Close to the Right`,
            disabled: toRight.size === 0,
            shortcut: commandShortcut(`chat.closeTabsToRight`),
            command: () => emit(`close`, toRight),
        },
        { separator: true },
        {
            label: `Close Finished`,
            disabled: finished.size === 0,
            shortcut: commandShortcut(`chat.closeFinishedTabs`),
            command: () => emit(`close`, finished),
        },
        { label: `Close All`, shortcut: commandShortcut(`chat.closeAllTabs`), command: () => emit(`close`, allTabs()) },
        { separator: true },
        {
            label: poppedOut.value ? `Dock chat back` : `Move chat into new window`,
            shortcut: commandShortcut(`chat.togglePopout`),
            command: togglePopout,
        },
    ];
});

const openTabMenu = (id: string, event: Event): void => {
    // The pointer stays on the card, so the hover preview would never leave on its own — and it floats exactly
    // where the menu is about to open.
    hidePreview();
    menuTabId.value = id;
    tabMenu.value?.show(event);
};

// Close a chat without selecting it (the × sits inside the card button, so stop the bubble).
const closeTab = (event: Event, id: string): void => {
    event.stopPropagation();
    emit(`close`, new Set([id]));
};
</script>

<template>
    <div class="flex min-h-0 flex-col gap-1.5">
        <!-- Pinned above the list: narrow it (filter) → pick one (the lanes) → and, when the query reaches
             past what is open, the "Not open" group at the foot. -->
        <FilterField
            v-model="filterQuery"
            :busy="searching"
            label="Filter chats by your messages"
            placeholder="Filter by your messages…"
            class="shrink-0"
        />
        <div ref="scroller" class="scrollbar-thin flex min-h-0 flex-1 flex-col items-stretch gap-1.5 overflow-y-auto">
            <template v-for="lane in LANES" :key="lane.key">
                <!-- A lane with nothing in it is hidden; a lane the FILTER emptied keeps its header and says
                     so, so the list doesn't reshuffle under the cursor mid-keystroke. -->
                <template v-if="lanes[lane.key].length > 0">
                    <div class="mt-2.5 flex items-center gap-1.5 px-1 text-2xs font-semibold uppercase tracking-wide text-subtle first:mt-0">
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="lane.dot"></span>
                        <span>{{ lane.label }}</span>
                        <span class="font-normal">{{ countIn(lane.key) }}</span>
                    </div>
                    <p v-if="cardsIn(lane.key).length === 0" class="px-1 pb-1 text-2xs text-subtle">No matches</p>
                    <template v-for="{ conversation: c, agent } in cardsIn(lane.key)" :key="c.conversationId">
                        <!-- Renaming REPLACES the card rather than nesting a field inside it: an input in a
                             button is neither valid markup nor a usable caret. Enter commits, Esc cancels, blur
                             commits, an empty or unchanged name silently cancels — the WorkspaceTree
                             convention, via createTitleEdit. -->
                        <input
                            v-if="edit.editing && renamingId === c.conversationId"
                            v-model="edit.draft"
                            type="text"
                            maxlength="80"
                            aria-label="Chat title"
                            :placeholder="c.isolated.value ? 'New agent' : 'New chat'"
                            class="w-full shrink-0 select-text rounded-md bg-overlay px-2 py-1 text-2xs text-content outline-none ring-1 ring-primary-500/50 placeholder:text-subtle"
                            @keydown.enter.stop.prevent="edit.commit()"
                            @keydown.esc.stop.prevent="edit.cancel()"
                            @blur="edit.blurCommit()"
                            @vue:mounted="edit.focusInput"
                        />
                        <button
                            v-else
                            type="button"
                            :data-chat-tab="c.conversationId"
                            class="chat-tab rail-card group flex w-full min-w-0 shrink-0 flex-col gap-1 rounded-lg px-2.5 py-2 text-left text-2xs"
                            :class="{ 'chat-tab-on': activeId === c.conversationId, 'rail-card-attention': lane.key === 'attention' }"
                            @click="emit('select', c.conversationId)"
                            @dblclick.prevent.stop="beginRename(c.conversationId)"
                            @contextmenu.prevent.stop="openTabMenu(c.conversationId, $event)"
                            @mouseenter="showPreview($event, c, agent)"
                            @mouseleave="hidePreview"
                        >
                            <span class="flex w-full min-w-0 items-start gap-1.5">
                                <!-- Status leads the TITLE row — it is the first thing a glance asks. Sideways
                                     for the same reason the title below is: under a card is the next card. -->
                                <span class="flex h-4 shrink-0 items-center">
                                    <Icon
                                        :name="statusOf({ conversation: c, agent }).icon"
                                        :spin="statusOf({ conversation: c, agent }).spin"
                                        :class="statusOf({ conversation: c, agent }).class"
                                        :aria-label="statusOf({ conversation: c, agent }).label"
                                    />
                                </span>
                                <OriginMark :origin="originOf(c)" compact />
                                <span v-if="isArchived(c)" class="mt-px flex shrink-0 items-center" aria-label="Archived">
                                    <Icon name="box" class="text-2xs text-subtle" />
                                </span>
                                <!-- Two lines before the clamp — a card has the width for most titles whole.
                                     Neutral, always: the status colour lives in the glyph beside it, and a
                                     column of orange titles is one where nothing stands out. -->
                                <span class="line-clamp-2 min-w-0 flex-1 font-medium leading-4 text-content">
                                    <span
                                        v-for="(run, at) in markSegments(tabLabel(c), needle)"
                                        :key="at"
                                        :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''"
                                        >{{ run.text }}</span
                                    >
                                </span>
                                <PresenceAvatars
                                    v-if="c.session.value !== undefined"
                                    :members="viewersOfSession(c.session.value.id)"
                                    label="in this chat"
                                />
                                <!-- The × is a HIT TARGET carrying the glyph, not the glyph itself: at text-2xs
                                     the svg is an 11px square, and a click that misses it lands on the card —
                                     which, on the card it is closing, selects an already-selected chat and so
                                     reads as a close that did nothing. -->
                                <span
                                    v-if="conversations.length > 1"
                                    role="button"
                                    aria-label="Close chat"
                                    class="-mr-2 -mt-1 flex shrink-0 items-center px-2 py-1 opacity-0 transition-opacity hover:text-content group-hover:opacity-60"
                                    @click="closeTab($event, c.conversationId)"
                                >
                                    <Icon name="times" class="mt-px text-2xs" />
                                </span>
                            </span>
                            <template v-if="agent !== undefined">
                                <!-- The crucial numbers, one wrapping line: cost, diff, and — right-aligned —
                                     the running elapsed (ticking) or the last-activity age. All quiet: these
                                     are reference numbers, not events.
                                     The MODEL is a mark, not a word: in a column this narrow "Claude Opus 5"
                                     costs a quarter of the line to repeat what the provider glyph beside it
                                     already says, and it is the same on every card in a fleet run on one
                                     model. The name stays one hover away, on the glyph that stands for it. -->
                                <span class="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-subtle">
                                    <span
                                        v-if="attentionReason(agent) !== undefined"
                                        class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px font-semibold text-warning"
                                        >{{ attentionReason(agent) }}</span
                                    >
                                    <span class="flex shrink-0 items-center">
                                        <ProviderLogo :provider="agent.provider" class="text-2xs" />
                                    </span>
                                    <span v-if="agent.costUsd !== undefined">{{ formatCost(agent.costUsd) }}</span>
                                    <span
                                        v-if="agent.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0)"
                                        class="font-mono"
                                    >
                                        <span class="text-success">+{{ agent.diff.insertions }}</span>
                                        <span class="text-danger"> −{{ agent.diff.deletions }}</span>
                                    </span>
                                    <!-- The now-column, right-aligned: what it is doing (the tool's glyph, its
                                         command on hover) and how long it has been at it. Both are held through
                                         a stop's UNWIND (turnInFlight, not `running`): the turn is still live
                                         there, the elapsed keeps its meaning, and the glyph freezes on what it
                                         was doing when the user stopped it. Blinking the whole column off a beat
                                         before the card settles is the same flicker the stopping state exists
                                         to remove. -->
                                    <span class="ml-auto flex shrink-0 items-center gap-1.5">
                                        <Icon
                                            v-if="turnInFlight(agent) && agent.activity !== undefined"
                                            :name="activityIcon(agent.activity.tool)"
                                            class="text-2xs text-subtle"
                                        />
                                        <span v-if="turnInFlight(agent) && agent.startedAt !== undefined">{{
                                            formatElapsed(agent.startedAt, now)
                                        }}</span>
                                        <span v-else-if="agent.updatedAt > 0">{{ relativeTime(agent.updatedAt) }}</span>
                                    </span>
                                </span>
                                <!-- WHY this chat survived the filter, when the reason isn't its title (that one
                                     is marked in place above). The board's cards carry the same line for the
                                     same reason: a result the user can't see the cause of is one they stop
                                     believing. -->
                                <span v-if="snippetOf(agent) !== undefined" class="flex w-full min-w-0 items-start gap-1 text-2xs text-muted">
                                    <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                                    <span class="line-clamp-2 min-w-0 flex-1 italic leading-4">
                                        <span
                                            v-for="(run, at) in markSegments(snippetOf(agent) ?? '', needle)"
                                            :key="at"
                                            :class="run.hit ? 'rounded-sm bg-primary-600/30 not-italic text-content' : ''"
                                            >{{ run.text }}</span
                                        >
                                    </span>
                                </span>
                            </template>
                        </button>
                    </template>
                </template>
            </template>

            <!-- WHAT THE QUERY FOUND THAT ISN'T OPEN HERE. This list holds the chats of this window, which is
                 almost never the set the question "where did I say X" is about — so the filter reaches the
                 whole fleet (live agents, the archive) and the conversations no agent owns, and puts them here.
                 A row opens the conversation, which is exactly the act the History menu performs; the
                 difference is that this list was found rather than browsed. -->
            <template v-if="filtering && notOpenCount > 0">
                <div class="mt-2 flex items-center gap-1.5 border-t border-line px-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-subtle">
                    <Icon name="search" class="shrink-0 text-2xs" />
                    <span>Not open</span>
                    <span class="font-normal">{{ notOpenCount }}</span>
                </div>
                <button
                    v-for="agent in notOpen"
                    :key="agent.id"
                    type="button"
                    class="chat-tab flex w-full min-w-0 shrink-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-2xs"
                    @click="emit('open', agent.id)"
                >
                    <span class="flex w-full min-w-0 items-start gap-1.5">
                        <ProviderLogo :provider="agent.provider" class="mt-px shrink-0 text-2xs text-muted" />
                        <!-- Off the board but not gone: the branch, the diff and the transcript all survive an
                             archive, so a hit here is a real destination rather than a tombstone. -->
                        <Icon v-if="agent.archivedAt !== undefined" name="box" class="mt-px shrink-0 text-2xs text-subtle" aria-label="Archived" />
                        <span class="line-clamp-2 min-w-0 flex-1 leading-4 text-muted">
                            <span
                                v-for="(run, at) in markSegments(agent.title ?? 'Untitled agent', needle)"
                                :key="at"
                                :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''"
                                >{{ run.text }}</span
                            >
                        </span>
                        <span v-if="agent.updatedAt > 0" class="mt-px shrink-0 text-subtle">{{ relativeTime(agent.updatedAt) }}</span>
                    </span>
                    <span v-if="snippetOf(agent) !== undefined" class="line-clamp-2 pl-4 italic leading-4 text-subtle">
                        <span
                            v-for="(run, at) in markSegments(snippetOf(agent) ?? '', needle)"
                            :key="at"
                            :class="run.hit ? 'rounded-sm bg-primary-600/30 not-italic text-content' : ''"
                            >{{ run.text }}</span
                        >
                    </span>
                </button>
                <!-- Conversations no agent entry owns — a plain chat, or one whose entry is long gone. Nothing
                     to draw a provider mark or a status for; the title and the matched line are the whole of
                     what is known about them. -->
                <button
                    v-for="session in sessionMatches"
                    :key="session.id"
                    type="button"
                    class="chat-tab flex w-full min-w-0 shrink-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-2xs"
                    @click="emit('open', session.id)"
                >
                    <span class="flex w-full min-w-0 items-start gap-1.5">
                        <Icon name="comments" class="mt-px shrink-0 text-2xs text-subtle" />
                        <span class="line-clamp-2 min-w-0 flex-1 leading-4 text-muted">{{ session.title }}</span>
                        <span class="mt-px shrink-0 text-subtle">{{ relativeTime(session.updatedAt) }}</span>
                    </span>
                    <span v-if="session.snippet !== undefined" class="line-clamp-2 pl-4 italic leading-4 text-subtle">{{ session.snippet }}</span>
                </button>
            </template>
        </div>
        <!-- A failed rename already reverted the title; this says why. Cleared by the next rename. -->
        <span v-if="edit.error !== undefined" class="shrink-0 truncate px-1 text-2xs text-danger" v-tooltip.bottom.overflow="edit.error">{{
            edit.error
        }}</span>

        <!-- Both of these teleport out (the hover card to the overlay target, the menu to `append-to`), so
             they sit inside the root only to keep this component single-rooted — a fragment root would drop
             the sizing classes its two hosts hand it. Into the pop-out window while the chat floats there. -->
        <HoverCard ref="hoverCard" :to="overlayTarget" />
        <ContextMenu ref="tabMenu" :model="tabMenuItems" :append-to="overlayTarget" :min-width="13" />
    </div>
</template>

<style scoped>
/* The card's surface — AgentCard's skin (visible border, distinct fill) over .chat-tab's behaviour. A
 * transparent pill blends into a column of pills; a bordered card is what makes each session a countable
 * thing. Scoped selectors outweigh chat.css's single-class rules, so these win without !important. */
.rail-card {
    border-color: var(--color-line);
    background: color-mix(in srgb, var(--color-canvas) 45%, transparent);
    /* Two independent marks on one box-shadow: the attention bar (inset, left edge) and the active ring
       (outset, all round). Held as variables because a second box-shadow rule would REPLACE the first, which
       is what forced the old either/or below. */
    --rail-accent: 0 0 #0000;
    --rail-ring: 0 0 #0000;
    box-shadow: var(--rail-accent), var(--rail-ring);
}
.rail-card:hover {
    border-color: var(--color-line-strong);
}
/* THE SAME TWO CHANNELS THE BOARD USES (see AgentCard): the card the transcript beside it is showing gets a
 * ring and a lifted fill, an agent that needs the user gets a bar down its left edge. Drawn in different
 * places, so the list no longer has to choose between them — the old rule dropped the warning the moment you
 * opened the card, on the theory that "you are here" outranks "this needs you", which quietly cost the one
 * card most likely to be read the only mark saying why it was in that lane. An inset shadow rather than a
 * wider left border: no layout shift, so a stacked lane's cards keep their text on one axis. */
.rail-card.chat-tab-on {
    border-color: var(--color-primary-500);
    background: var(--color-overlay);
    --rail-ring: 0 0 0 2px color-mix(in srgb, var(--color-primary-500) 50%, transparent);
}
.rail-card-attention {
    --rail-accent: inset 3px 0 0 0 var(--color-warning);
}
</style>

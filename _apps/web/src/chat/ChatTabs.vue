<script setup lang="ts">
import { cmp, type IconName } from "@intentic-app/ui";
import type { Disposable } from "@intentic/extension-api";
import type { AgentOrigin } from "@intentic/sandbox-contract";
import ContextMenu from "primevue/contextmenu";
import type { MenuItem } from "primevue/menuitem";
import Popover from "primevue/popover";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { startAgent } from "../composables/agents/agentActions";
import { createTitleEdit } from "../composables/agents/titleEdit";
import { markSegments, useAgentFilter } from "../composables/agents/useAgentFilter";
import { type FleetAgent, useAgents } from "../composables/agents/useAgents";
import FilterField from "../components/FilterField.vue";
import HoverCard from "../components/HoverCard.vue";
import OriginMark from "../components/OriginMark.vue";
import ProviderLogo from "./ProviderLogo.vue";
import { activityIcon, agentStatusMeta, attentionReason, type FleetLane, formatCost, formatElapsed, laneOf } from "../composables/agents/agentStatus";
import { relativeTime, statusIcon, statusLabel, statusTabClass } from "../composables/chat/catalog";
import { type Conversation, modelLabelFor } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { inTabSurface } from "../composables/commands/tabSurface";
import { commandShortcut, registerCommand, type RegisteredCommand } from "../composables/commands/useCommands";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";

/* The tab strip + history menu. Reads the conversation list from the useChat singleton and emits select /
 * close / open rather than writing it: the strip is a view of the tabs, and the panel it lives in is what
 * hands each verb to the store. "New agent" is not one of them: it means the same thing here as on the fleet
 * board, so both call the one startAgent action (agents/agentActions.ts) instead of each surface assembling
 * its own half of it. */

const emit = defineEmits<{
    select: [id: string];
    // A SET, not an id: the tab × closes one, the right-click menu's Close Others / to the Right / All close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, sessions, loadSessions } = useChat();
const { agentById, fleet, archived, loadArchived } = useAgents();
const { poppedOut, toggle: togglePopout, overlayTarget } = useChatPopout();

/* Undocked, the strip stands up the window's LEFT EDGE as a resizable rail of CARDS instead of wrapping pill
 * tabs across the top. A pop-out window is as wide as the user drags it, so a top strip spends the one axis
 * the chat is short of (height) on a row that has width to burn — while a rail has room to be a slice of the
 * fleet board: the same Attention | Active | Finished lanes, each open tab a compact card wearing the crucial
 * facts (provider mark, a two-line title, the attention chip, cost / diff / elapsed, the live activity line).
 * Docked, the chat column is ~22rem: a card rail there would halve the transcript, so the flat strip stays. */
const vertical = computed(() => poppedOut.value);

// --- Undocked rail: the board's lanes in miniature ----------------------------------------------
interface RailEntry {
    readonly conversation: Conversation;
    readonly agent: FleetAgent | undefined;
}
const fleetById = computed(() => new Map(fleet.value.map((agent) => [agent.id, agent])));
const lastActive = (entry: RailEntry): number => entry.agent?.updatedAt ?? 0;

/* Which lane a TAB belongs to. laneOf is the board's own projection, so a tab can never sit in a different lane
 * here than its card does on /agents. A conversation the fleet has never carded (a plain non-isolated chat, or
 * the roster briefly down) still needs a shelf: streaming or empty reads as Active, anything else as Finished.
 * The rail groups its cards by this, and the right-click menu's "Close Finished" takes exactly the lane it
 * names — one definition of "finished", so the row can't close a card the rail is still showing as Active. */
const laneOfTab = (conversation: Conversation): FleetLane => {
    const agent = fleetById.value.get(conversation.conversationId);
    if (agent !== undefined) {
        return laneOf(agent);
    }
    return conversation.streaming.value || conversation.messages.value.length === 0 ? `active` : `finished`;
};

/* --- The rail's filter -------------------------------------------------------------------------
 * The same field, the same rule and the same evidence as the fleet board's (useAgentFilter): match what the
 * USER wrote — the title, which is their sanitized first prompt, and every later prompt in the transcript.
 * Two search boxes in one product that disagree about what "matches" means is worse than one of them not
 * existing, so both mount the one composable rather than each rolling its own.
 *
 * What differs is the SET. The board filters the fleet; this rail lists the OPEN TABS, which is a much
 * smaller thing to be looking through — a user in a popped-out window asking "where did I say X" is almost
 * never asking only about the eight tabs they happen to have open. So the query reaches the whole fleet here
 * too, and everything it finds that ISN'T open lands in a group below the lanes that opens on click. The
 * history popover keeps its own box for browsing; this one is for finding.
 *
 * Its state is per-INSTANCE, which for a rail means per-window: a query typed on the board must not narrow a
 * pop-out the user isn't looking at.
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

// A tab with no fleet entry (a plain chat, or the roster briefly down) has no transcript the daemon can
// search under an agent id, so it is matched on what this browser holds: its title and its own user messages.
const tabMatches = (entry: RailEntry): boolean => {
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

const railLanes = computed<Record<FleetLane, RailEntry[]>>(() => {
    const grouped: Record<FleetLane, RailEntry[]> = { attention: [], active: [], finished: [] };
    for (const conversation of conversations.value) {
        grouped[laneOfTab(conversation)].push({ conversation, agent: fleetById.value.get(conversation.conversationId) });
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
const RAIL_LANES: readonly { key: FleetLane; label: string; dot: string }[] = [
    { key: `attention`, label: `Attention`, dot: `bg-warning` },
    { key: `active`, label: `Active`, dot: `bg-success` },
    { key: `finished`, label: `Finished`, dot: `bg-line-strong` },
];

// A lane's visible tabs, and how many of its own it is showing. Same `n of m` the board's lane headers carry,
// for the same reason: a lane that silently shrinks is a lane that has stopped saying anything.
const railCards = (lane: FleetLane): RailEntry[] => railLanes.value[lane].filter(tabMatches);
const railCount = (lane: FleetLane): string =>
    filtering.value ? `${railCards(lane).length} of ${railLanes.value[lane].length}` : String(railLanes.value[lane].length);

// The card's status glyph, worn ON THE TITLE ROW like the docked tabs wear theirs — status is the first
// question a rail answers, so it doesn't belong buried in the numbers line. Fleet-carded tabs read the
// agent's own status (the richer machine: landed, conflict…); a plain chat degrades to what its
// conversation is doing right now, through the same statusIcon the docked strip draws.
const railStatus = (entry: RailEntry): { icon: IconName; spin?: boolean; label: string; class: string } => {
    if (entry.agent !== undefined) {
        const meta = agentStatusMeta(entry.agent.status);
        return { ...meta, class: `text-2xs ${meta.class}` };
    }
    const status = entry.conversation.status.value;
    const icon = statusIcon(status);
    return { icon: icon.name, spin: icon.spin, label: statusLabel(status), class: icon.class };
};

/* What the query found that ISN'T open in this window — the whole point of the rail's filter reaching past its
 * own list. Live fleet agents first (the likeliest thing to want), then the archive, each as a row that opens
 * the conversation. Conversations no agent owns come from `sessionMatches` and open the same way.
 *
 * The archive is off the live roster, so its contents have to be asked for; the board does that at mount, but
 * a user who popped the chat out and never opened /agents has no reason to have paid for it. Asked for once,
 * the first time a query is typed here.
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

// One second ticks every running card's elapsed readout together (the board's `now` pattern) — armed only
// while the rail is up, so the docked strip pays for no timer it doesn't render.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
watch(
    vertical,
    (on) => {
        clearInterval(ticker);
        ticker = on
            ? setInterval(() => {
                  now.value = Date.now();
              }, 1000)
            : undefined;
    },
    { immediate: true },
);
onBeforeUnmount(() => clearInterval(ticker));

// --- Rail width ---------------------------------------------------------------------------------
// The rail resizes off its right edge (pointer capture, double-click resets) and persists like the panel
// widths in useLayout — but locally, because it exists only in the pop-out window.
const RAIL_WIDTH_KEY = `ui-chat-rail-width`;
const DEFAULT_RAIL_WIDTH = 240;
const clampRailWidth = (px: number): number => Math.round(Math.max(176, Math.min(px, 480)));
const readRailWidth = (): number => {
    try {
        const parsed = Number.parseInt(localStorage.getItem(RAIL_WIDTH_KEY) ?? ``, 10);
        return Number.isFinite(parsed) ? clampRailWidth(parsed) : DEFAULT_RAIL_WIDTH;
    } catch {
        return DEFAULT_RAIL_WIDTH;
    }
};
const railWidth = ref(readRailWidth());
const setRailWidth = (px: number): void => {
    railWidth.value = clampRailWidth(px);
    try {
        localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth.value));
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};
const railResizing = ref(false);
const startRailResize = (event: PointerEvent): void => {
    event.preventDefault();
    railResizing.value = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
};
// The rail is flush with the pop-out window's left edge, so its width IS the pointer's x in that window.
const onRailResize = (event: PointerEvent): void => {
    if (railResizing.value) {
        setRailWidth(event.clientX);
    }
};
const endRailResize = (event: PointerEvent): void => {
    if (!railResizing.value) {
        return;
    }
    railResizing.value = false;
    const target = event.target as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
    }
};

// What a tab calls a conversation: its derived title, else the noun for where it
// works — an untitled isolated conversation IS a draft agent card on the fleet board.
const tabLabel = (conversation: Conversation): string => conversation.title.value ?? (conversation.isolated.value ? `New agent` : `New chat`);

// Which tabs were opened by an outside message rather than by the user (the registry entry is where that
// fact lives, so it's read from the fleet). The strip wears the source glyph alone — the title of such a tab
// already leads with who sent the message.
const originOf = (conversation: Conversation): AgentOrigin | undefined => agentById(conversation.conversationId)?.origin;

// Off the board, still open. Archiving CLOSES an agent's tab (see the archive note in useAgents), so what lands
// here is the other way round: a tab opened FROM the archive, or one whose agent the daemon's retention sweep
// filed away. The strip is what says so for a BACKGROUND tab — the panel's own line only speaks for the active
// one, and a tab that looks identical to a live agent is how "didn't I just archive that?" starts.
const isArchived = (conversation: Conversation): boolean => agentById(conversation.conversationId)?.archivedAt !== undefined;

const history = ref<InstanceType<typeof Popover> | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);

// The history search box. Filters the list by chat title or content (content scanned server-side over recent
// sessions). Debounced so a keystroke burst becomes one request; the list binds directly to `sessions`.
const query = ref(``);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadSessions(value.trim() || undefined), 200);
});
onBeforeUnmount(() => clearTimeout(searchTimer));

// --- Inline tab rename -------------------------------------------------------------------------
// One edit state for the whole strip (only one tab renames at a time), pointed at a tab by `renamingId`. The
// write goes through the same createTitleEdit the fleet cards use, so a chat renamed here renames the agent
// registry entry too — the tab and its card are one thing under two skins. Reached by double-clicking a tab
// (the terminal strip's gesture) or F2, the app-wide rename key.
const strip = ref<HTMLElement | null>(null);
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

// F2 targets the tab the focus is actually ON (Tab-navigating the strip lands on tabs that aren't active),
// falling back to the active conversation for a press from anywhere else in the panel — the composer, the
// transcript. Read off the strip's own document so a popped-out chat resolves ITS focus, not the main window's.
const focusedTabId = (): string | undefined => {
    const focused = strip.value?.ownerDocument.activeElement;
    const tab = focused instanceof Element ? focused.closest(`[data-chat-tab]`) : null;
    return tab instanceof HTMLElement ? tab.dataset[`chatTab`] : undefined;
};

// --- Hover preview --------------------------------------------------------------------------------
// A tab wears its title clipped to whatever width its row gave it, on top of the 40-char derivation, so
// hovering reveals the FULL
// derived title and, under it, the first message that title was derived from. The card itself is the shared
// HoverCard — the Changes panel's agent chips raise the same one for the same session.
const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);

const showPreview = (event: MouseEvent, conversation: Conversation): void => {
    const firstUser = conversation.messages.value.find((message) => message.role === `user`);
    // A fresh "New chat"/"New agent" tab has neither, and the card declines to open on empty content.
    hoverCard.value?.show(event, { title: conversation.title.value ?? undefined, body: firstUser?.text });
};
const hidePreview = (): void => {
    hoverCard.value?.hide();
};

// --- Closing ------------------------------------------------------------------------------------
// The close sets the strip can ask for, named the way the menu names them. Read off the live list from inside the
// menu's own computed, so a tab that arrives while the menu sits open (an inbound Discord mention opens one) is
// folded into the set rather than escaping a snapshot taken at right-click time.
const othersOf = (id: string): ReadonlySet<string> =>
    new Set(conversations.value.filter((c) => c.conversationId !== id).map((c) => c.conversationId));
const toRightOf = (id: string): ReadonlySet<string> => {
    const index = conversations.value.findIndex((c) => c.conversationId === id);
    return new Set(index === -1 ? [] : conversations.value.slice(index + 1).map((c) => c.conversationId));
};
const allTabs = (): ReadonlySet<string> => new Set(conversations.value.map((c) => c.conversationId));

/* Every tab that has stopped working — the Finished lane, whatever the strip's orientation. This is the sweep a
 * long session actually wants: a dozen tabs accumulate, two are still running, and neither Close Others nor
 * Close to the Right can express "clear the done ones" without hunting for them one × at a time. The ACTIVE tab
 * is not spared if it is finished; being the tab you are looking at is not a reason to keep a landed agent open,
 * and closing it selects the last survivor the way every other close here does. */
const finishedTabs = computed<ReadonlySet<string>>(
    () => new Set(conversations.value.filter((c) => laneOfTab(c) === `finished`).map((c) => c.conversationId)),
);

// No close asks for a confirm, mass or single — unlike the workspace's file tabs, where closing discards unsaved
// edits, closing a chat destroys nothing. A running agent's turn is detached daemon-side (Conversation.abort is
// soft by design), so it keeps working and lands its work with the tab gone; the conversation stays in the
// sandbox's store, and reopening it from the history menu reattaches to the still-live turn.

// --- Right-click menu -----------------------------------------------------------------------------
// The same close set the workspace's file tabs carry, plus this strip's own rename and the pop-out toggle. One
// menu serves both right-click targets: on a tab it acts on the RIGHT-CLICKED one (`menuTabId`), while on the
// strip's empty space (`menuTabId` undefined) only the rows that need no tab survive. The commands further down
// act on the ACTIVE tab instead — the split the workspace makes.
const tabMenu = ref<{ show: (event: Event) => void } | undefined>();
const menuTabId = ref<string>();

// The rows that name no particular tab: they tail a tab's menu and they ARE the empty-space one.
const stripItems = computed<MenuItem[]>(() => [
    {
        label: `Close Finished`,
        disabled: finishedTabs.value.size === 0,
        shortcut: commandShortcut(`chat.closeFinishedTabs`),
        command: () => emit(`close`, finishedTabs.value),
    },
    { label: `Close All`, shortcut: commandShortcut(`chat.closeAllTabs`), command: () => emit(`close`, allTabs()) },
    { separator: true },
    {
        label: poppedOut.value ? `Dock chat back` : `Move chat into new window`,
        shortcut: commandShortcut(`chat.togglePopout`),
        command: togglePopout,
    },
]);

const tabMenuItems = computed<MenuItem[]>(() => {
    const id = menuTabId.value;
    if (id === undefined) {
        return stripItems.value;
    }
    if (!conversations.value.some((c) => c.conversationId === id)) {
        return []; // the right-clicked tab closed under the open menu
    }
    const others = othersOf(id);
    const toRight = toRightOf(id);
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
        ...stripItems.value, // Close All, then the pop-out toggle behind its own separator
    ];
});

const openTabMenu = (id: string, event: Event): void => {
    // The pointer stays on the tab, so the hover card would never leave on its own — and it floats exactly where
    // the menu is about to open.
    hidePreview();
    menuTabId.value = id;
    tabMenu.value?.show(event);
};

// Registered while THIS strip is mounted — the desktop strip and the mobile one are exclusive, so the ids can't
// double-register.
//
// Every chord here is the SHELL-WIDE tab family (tabSurface.ts): the same Ctrl+Shift+{X , . Backspace} the
// workspace's file tabs carry and the same Alt+PageUp/PageDown cycling, claimed only while the focus is inside
// the chat panel. Three strips are on screen at once, so one chord per verb resolved by focus beats three
// chords per verb memorized — it's what F2/rename has always done here. Each is rebindable in
// Settings → Keybindings, per surface: remapping Close Chat leaves Close Tab where it was.
//
// Cycling emits `select` rather than writing activeId, so it takes the same road as a click on a tab: through
// the panel, which routes it to the store's one writer of the tab list and of the focus (see useChat.setActive).
let commandDisposables: readonly Disposable[] = [];
const cycleTab = (delta: number): void => {
    const list = conversations.value;
    if (list.length < 2) {
        return;
    }
    const index = list.findIndex((c) => c.conversationId === activeId.value);
    const next = list[(index + delta + list.length) % list.length];
    if (next !== undefined) {
        emit(`select`, next.conversationId);
    }
};
onMounted(() => {
    const entries: Omit<RegisteredCommand, `owner`>[] = [
        {
            command: `chat.rename`,
            title: `Rename Chat…`,
            icon: `pencil`,
            keybinding: `F2`,
            when: inTabSurface(`chat`),
            handler: (): void => {
                if (edit.editing) {
                    return; // already renaming — a second F2 would wipe the draft
                }
                const target = focusedTabId() ?? activeId.value;
                if (target !== ``) {
                    beginRename(target);
                }
            },
        },
        {
            command: `chat.closeTab`,
            title: `Close Chat`,
            icon: `times`,
            keybinding: `Ctrl+Shift+X`,
            when: inTabSurface(`chat`),
            handler: () => emit(`close`, new Set([activeId.value])),
        },
        {
            command: `chat.closeOtherTabs`,
            title: `Close Other Chats`,
            icon: `times`,
            keybinding: `Ctrl+Shift+,`,
            when: inTabSurface(`chat`),
            handler: (): void => {
                const others = othersOf(activeId.value);
                if (others.size > 0) {
                    emit(`close`, others);
                }
            },
        },
        {
            command: `chat.closeTabsToRight`,
            title: `Close Chats to the Right`,
            icon: `times`,
            keybinding: `Ctrl+Shift+.`,
            when: inTabSurface(`chat`),
            handler: (): void => {
                const toRight = toRightOf(activeId.value);
                if (toRight.size > 0) {
                    emit(`close`, toRight);
                }
            },
        },
        {
            // Unbound by default: the shell-wide tab family (Ctrl+Shift+{X , . Backspace}) is the set the
            // workspace's file tabs share, and "finished" is a fact only an agent chat has — there is no file-tab
            // verb to pair a chord with. It reaches the palette and Settings → Keybindings like any other command,
            // and the menu row shows a chord the moment one is bound.
            command: `chat.closeFinishedTabs`,
            title: `Close Finished Chats`,
            icon: `times`,
            when: inTabSurface(`chat`),
            handler: (): void => {
                if (finishedTabs.value.size > 0) {
                    emit(`close`, finishedTabs.value);
                }
            },
        },
        {
            command: `chat.closeAllTabs`,
            title: `Close All Chats`,
            icon: `times`,
            keybinding: `Ctrl+Shift+Backspace`,
            when: inTabSurface(`chat`),
            handler: () => emit(`close`, allTabs()),
        },
        { command: `chat.nextTab`, title: `Next Chat`, keybinding: `Alt+PageDown`, when: inTabSurface(`chat`), handler: () => cycleTab(1) },
        { command: `chat.previousTab`, title: `Previous Chat`, keybinding: `Alt+PageUp`, when: inTabSurface(`chat`), handler: () => cycleTab(-1) },
    ];
    commandDisposables = entries.map((entry) => registerCommand({ owner: `builtin`, ...entry }));
});
onBeforeUnmount(() => {
    for (const disposable of commandDisposables) {
        disposable.dispose();
    }
    commandDisposables = [];
});

// Close a tab without selecting it (the × sits inside the tab button, so stop the bubble).
const closeTab = (event: Event, id: string): void => {
    event.stopPropagation();
    emit(`close`, new Set([id]));
};

/* Right-click anywhere on the strip that ISN'T a tab opens the tab-less menu (Close Finished, Close All, the
 * pop-out toggle) rather than popping the chat out on the spot — an accidental right-click near the tabs shouldn't
 * tear the panel into its own window.
 *
 * The handler sits on the whole header, not on the scroll box the tabs live in: the ✚ and history buttons are
 * SIBLINGS of that box (they stay put while the tabs scroll), and so is the rename error line, so a right-click
 * on or around them used to fall through to the browser's own menu — the one bit of the strip that looked like
 * tab chrome and behaved like a web page. Tab and rail-card right-clicks stop the event themselves, so anything
 * arriving here is chrome by construction; the only thing spared is a text field, which keeps the browser's
 * editing menu (the rename input, the rail's filter box). */
const onStripContextMenu = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest(`input, textarea`) !== null) {
        return;
    }
    event.preventDefault();
    menuTabId.value = undefined;
    tabMenu.value?.show(event);
};

const openHistory = (event: Event): void => {
    query.value = ``;
    void loadSessions();
    history.value?.toggle(event);
};
</script>

<template>
    <!-- Docked: a header across the top of the chat column. Undocked: a resizable rail of lane-grouped cards
         down the window's left edge, over a foot that carries the same ✚ / history pair the docked strip wears
         beside it — there as two bare glyphs, here as a labelled "Past chats" row and a filled "New agent". -->
    <component
        :is="vertical ? 'aside' : 'header'"
        class="flex gap-1 border-line"
        :class="[
            vertical ? 'relative h-full shrink-0 flex-col items-stretch border-r p-1.5' : 'view-header view-header-wrap items-center border-b px-1.5',
            { 'rail-resizing': railResizing },
        ]"
        :style="vertical ? { width: `${railWidth}px` } : undefined"
        @contextmenu="onStripContextMenu"
    >
        <div
            v-if="vertical"
            class="rail-resize"
            @pointerdown="startRailResize"
            @pointermove="onRailResize"
            @pointerup="endRailResize"
            @dblclick="setRailWidth(DEFAULT_RAIL_WIDTH)"
            title="Drag to resize · double-click to reset"
        ></div>
        <!-- The rail's filter, pinned above the list. Only undocked: the docked strip is a row of pill tabs in
             a ~22rem column that already fights for width, and a field there would cost more than the handful
             of tabs it could narrow. The rail reads top-down as narrow it (filter) → pick one (the lanes) →
             leave it (the foot's two doors out). -->
        <FilterField
            v-if="vertical"
            v-model="filterQuery"
            :busy="searching"
            label="Filter chats by your messages"
            placeholder="Filter by your messages…"
            class="shrink-0"
        />
        <!-- Tabs fill one row, then wrap to a second; only past two rows does the strip scroll vertically. It
             never scrolls sideways, so no tab hides off the right edge.
             A tab is elastic, not a fixed 10rem box: basis-40 is what it ASKS for (so tabs wrap at the same
             counts they always did), and `grow` then hands each row's leftover width back to the tabs ON THAT
             ROW instead of leaving a gap between the last tab and the ✚ / history pair. Rows therefore differ
             in tab width — a row of two divides more slack than a row of four — which is the trade for every
             row spending its width on TITLE rather than on emptiness. max-w-72 is the ceiling: a derived title
             is 40 chars, which fits inside 18rem at text-2xs, so past that a lone tab would only stretch its
             own whitespace. Below it, min-w-20 still floors a squeezed strip.
             One row still measures exactly a
             .view-header (a 26px tab row plus its py-1 is under the 2.25rem floor), so the shell-wide header
             line reads unbroken until there are genuinely more tabs than fit; from the second row on, this bar
             alone stands taller (.view-header-wrap, styles.css). max-h-16 is those two rows WITH the padding —
             the strip is the scroll box, so its own py counts against the cap.
             A tab has no fixed height, so the row tracks the meta tier (text-2xs): at 0.6875rem/1rem it
             measures 26px, which is why the strip's own padding is py-0.5 and not more — one row then comes
             to 30px and still clears the 2.25rem floor (measured: the header lands on exactly 36px), while
             two rows plus the gap come to 60px, just inside max-h-16, and a third (90px) is well outside.
             All three numbers move together with --text-2xs; retune them together, never one alone.
             The ✚ and history buttons sit outside the strip, so they never move; their h-7 rides inside the
             floor with no header padding.
             None of that applies down the side: the rail owns the window's full height, so the lanes and their
             cards simply stack, and the list scrolls only when it outgrows the window. -->
        <div
            ref="strip"
            class="scrollbar-thin flex min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
            :class="vertical ? 'min-h-0 flex-col items-stretch gap-1.5' : 'max-h-16 flex-wrap items-center gap-1 py-0.5'"
        >
            <template v-if="!vertical">
                <template v-for="c in conversations" :key="c.conversationId">
                    <!-- Renaming REPLACES the tab rather than nesting a field inside it: an input in a button is
                         neither valid markup nor a usable caret. Enter commits, Esc cancels, blur commits, an empty
                         or unchanged name silently cancels — the WorkspaceTree convention, via createTitleEdit. -->
                    <input
                        v-if="edit.editing && renamingId === c.conversationId"
                        v-model="edit.draft"
                        type="text"
                        maxlength="80"
                        aria-label="Chat title"
                        :placeholder="c.isolated.value ? 'New agent' : 'New chat'"
                        class="w-40 shrink-0 select-text rounded-md bg-overlay px-2 py-1 text-2xs text-content outline-none ring-1 ring-primary-500/50 placeholder:text-subtle"
                        @keydown.enter.stop.prevent="edit.commit()"
                        @keydown.esc.stop.prevent="edit.cancel()"
                        @blur="edit.blurCommit()"
                        @vue:mounted="edit.focusInput"
                    />
                    <button
                        v-else
                        type="button"
                        :data-chat-tab="c.conversationId"
                        class="chat-tab group flex min-w-20 max-w-72 shrink-0 grow basis-40 items-center gap-1.5 rounded-md px-2 py-1 text-2xs"
                        :class="{ 'chat-tab-on': activeId === c.conversationId }"
                        @click="emit('select', c.conversationId)"
                        @dblclick.prevent.stop="beginRename(c.conversationId)"
                        @contextmenu.prevent.stop="openTabMenu(c.conversationId, $event)"
                        @mouseenter="showPreview($event, c)"
                        @mouseleave="hidePreview"
                    >
                        <!-- What this tab is doing, in the leading slot the mobile strip and the rail already give
                             it. Rendered for IDLE too (a dim dot, not nothing) so the slot's width is constant:
                             a glyph that appears only while streaming reflows every label in the strip on each
                             turn. `times` is a sibling, not an overlay — status never hides behind the close ×. -->
                        <Icon v-bind="statusIcon(c.status.value)" :aria-label="statusLabel(c.status.value)" class="shrink-0" />
                        <!-- Came in from outside (a Discord mention, a visitor, a webhook) rather than from you. -->
                        <OriginMark :origin="originOf(c)" compact />
                        <!-- Archived: the agent is off the board, but its conversation is still right here. -->
                        <span v-if="isArchived(c)" v-tooltip.bottom="'Archived — off the agents board'" class="flex shrink-0 items-center">
                            <Icon name="box" class="text-2xs text-subtle" />
                        </span>
                        <!-- One noun with the fleet: an untitled isolated conversation IS a draft agent card there. -->
                        <span class="min-w-0 flex-1 truncate text-left" :class="statusTabClass(c.status.value)">{{ tabLabel(c) }}</span>
                        <!-- Members with this same conversation active right now. -->
                        <PresenceAvatars v-if="c.session.value !== undefined" :viewers="viewersOfSession(c.session.value.id)" label="in this chat" />
                        <!-- The × is a HIT TARGET carrying the glyph, not the glyph itself: at text-2xs the svg
                             is an 11px square, and a click that misses it lands on the tab — which, on the tab it
                             is closing (the one the user is looking at), selects an already-selected tab and so
                             reads as a close that did nothing. The span is the row's full height and wears the
                             tab's own padding as slop, the same shape FileTabs and the mobile strip give it.
                             -my-1 cancels the py, so the target is the tab's full 24px height for free; -mr-2
                             spends the tab's right padding, leaving the target ~27×24 for 12px of title. It stops
                             short of the title on purpose — reaching further left would trade this miss for the
                             worse one, a click meant for the tab closing it. -->
                        <span
                            v-if="conversations.length > 1"
                            role="button"
                            aria-label="Close chat"
                            class="-my-1 -mr-2 flex shrink-0 items-center px-2 py-1 opacity-0 transition-opacity hover:text-content group-hover:opacity-60"
                            @click="closeTab($event, c.conversationId)"
                        >
                            <Icon name="times" class="text-2xs" />
                        </span>
                    </button>
                </template>
            </template>

            <!-- The rail: the fleet board's three lanes over the OPEN tabs, empty lanes hidden. Each card is
                 the tab it always was (click selects, double-click renames, right-click menus, × closes) —
                 wearing the crucial slice of its /agents card: status glyph on the title row, two lines of
                 title, cost / diff / elapsed, and the live activity line. The cards carry the BOARD's skin
                 (a bordered surface, AgentCard's) rather than the docked strip's transparent pill: a pill
                 disappears into a rail of pills, and "which sessions do I have" is the rail's first job.
                 Colour is spent the way the board spends it — status lives in the glyph and the semantic
                 chips; the title, the numbers and the activity line stay neutral, so the accent colour means
                 something when it does appear (the attention chip, a diff, an error). -->
            <template v-else>
                <template v-for="railLane in RAIL_LANES" :key="railLane.key">
                    <!-- A lane with nothing in it is hidden as before; a lane the FILTER emptied keeps its
                         header and says so, so the rail doesn't reshuffle under the cursor mid-keystroke. -->
                    <template v-if="railLanes[railLane.key].length > 0">
                        <div class="mt-2.5 flex items-center gap-1.5 px-1 text-2xs font-semibold uppercase tracking-wide text-subtle first:mt-0">
                            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="railLane.dot"></span>
                            <span>{{ railLane.label }}</span>
                            <span class="font-normal">{{ railCount(railLane.key) }}</span>
                        </div>
                        <p v-if="railCards(railLane.key).length === 0" class="px-1 pb-1 text-2xs text-subtle">No matches</p>
                        <template v-for="{ conversation: c, agent } in railCards(railLane.key)" :key="c.conversationId">
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
                                :class="{ 'chat-tab-on': activeId === c.conversationId, 'rail-card-attention': railLane.key === 'attention' }"
                                @click="emit('select', c.conversationId)"
                                @dblclick.prevent.stop="beginRename(c.conversationId)"
                                @contextmenu.prevent.stop="openTabMenu(c.conversationId, $event)"
                                @mouseenter="showPreview($event, c)"
                                @mouseleave="hidePreview"
                            >
                                <span class="flex w-full min-w-0 items-start gap-1.5">
                                    <!-- Status leads the TITLE row, where the docked tabs wear it — it is the
                                         first thing a glance at the rail asks. Sideways for the same reason the
                                         title below is: under a rail card is the next rail card. -->
                                    <span class="flex h-4 shrink-0 items-center" v-tooltip.right="railStatus({ conversation: c, agent }).label">
                                        <Icon
                                            :name="railStatus({ conversation: c, agent }).icon"
                                            :spin="railStatus({ conversation: c, agent }).spin"
                                            :class="railStatus({ conversation: c, agent }).class"
                                            :aria-label="railStatus({ conversation: c, agent }).label"
                                        />
                                    </span>
                                    <OriginMark :origin="originOf(c)" compact />
                                    <!-- Sideways, not down: the rail is a stack of cards, so a tooltip under one
                                         covers the next. Right of it is the transcript, which has room to spare. -->
                                    <span
                                        v-if="isArchived(c)"
                                        v-tooltip.right="'Archived — off the agents board'"
                                        class="mt-px flex shrink-0 items-center"
                                    >
                                        <Icon name="box" class="text-2xs text-subtle" />
                                    </span>
                                    <!-- Two lines before the clamp — a card has the width for most titles whole.
                                         Neutral, always: the status colour lives in the glyph beside it, and a
                                         rail of orange titles is a rail where nothing stands out. -->
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
                                        :viewers="viewersOfSession(c.session.value.id)"
                                        label="in this chat"
                                    />
                                    <!-- Same hit target as the flat strip's (see there): the glyph is 11px, the
                                         span is what the pointer actually has to find. -->
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
                                    <!-- The crucial numbers, one wrapping line: model (with its provider mark —
                                         they are one fact), cost, diff, and — right-aligned — the running
                                         elapsed (ticking) or the last-activity age. All quiet: these are
                                         reference numbers, not events. -->
                                    <span class="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-subtle">
                                        <span
                                            v-if="attentionReason(agent) !== undefined"
                                            class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px font-semibold text-warning"
                                            >{{ attentionReason(agent) }}</span
                                        >
                                        <span class="flex min-w-0 items-center gap-1">
                                            <ProviderLogo :provider="agent.provider" class="shrink-0 text-2xs" />
                                            <span v-if="agent.model !== undefined" class="max-w-28 truncate">{{
                                                modelLabelFor(agent.provider, agent.model)
                                            }}</span>
                                        </span>
                                        <span v-if="agent.costUsd !== undefined">{{ formatCost(agent.costUsd) }}</span>
                                        <span
                                            v-if="agent.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0)"
                                            class="font-mono"
                                        >
                                            <span class="text-success">+{{ agent.diff.insertions }}</span>
                                            <span class="text-danger"> −{{ agent.diff.deletions }}</span>
                                        </span>
                                        <span v-if="agent.status === 'running' && agent.startedAt !== undefined" class="ml-auto shrink-0">{{
                                            formatElapsed(agent.startedAt, now)
                                        }}</span>
                                        <span v-else-if="agent.updatedAt > 0" class="ml-auto shrink-0">{{ relativeTime(agent.updatedAt) }}</span>
                                    </span>
                                    <!-- What it is doing RIGHT NOW — the board card's live line, one truncated
                                         row. Muted, not accent-coloured: the spinner already says "working",
                                         and this line changes every few seconds — painting the noisiest line
                                         on the card in the loudest colour inverts the hierarchy. -->
                                    <span
                                        v-if="agent.status === 'running' && agent.activity !== undefined"
                                        class="flex w-full min-w-0 items-center gap-1 text-2xs text-muted"
                                    >
                                        <Icon :name="activityIcon(agent.activity.tool)" class="shrink-0 text-2xs text-subtle" />
                                        <span class="min-w-0 flex-1 truncate">{{
                                            agent.activity.todo ?? [agent.activity.tool, agent.activity.target].filter(Boolean).join(" · ")
                                        }}</span>
                                    </span>
                                    <!-- WHY this tab survived the filter, when the reason isn't its title (that
                                         one is marked in place above). The board's cards carry the same line for
                                         the same reason: a result the user can't see the cause of is one they
                                         stop believing. -->
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

                <!-- WHAT THE QUERY FOUND THAT ISN'T OPEN HERE. The rail lists the tabs of this window, which
                     is almost never the set the question "where did I say X" is about — so the filter reaches
                     the whole fleet (live agents, the archive) and the conversations no agent owns, and puts
                     them here. A row opens the conversation, which is exactly the act the History menu below
                     performs; the difference is that this list was found rather than browsed. -->
                <template v-if="filtering && notOpenCount > 0">
                    <div
                        class="mt-2 flex items-center gap-1.5 border-t border-line px-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-subtle"
                    >
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
                            <!-- Off the board but not gone: the branch, the diff and the transcript all survive
                                 an archive, so a hit here is a real destination rather than a tombstone. -->
                            <Icon
                                v-if="agent.archivedAt !== undefined"
                                name="box"
                                class="mt-px shrink-0 text-2xs text-subtle"
                                v-tooltip.bottom="'Archived — off the agents board'"
                            />
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
                    <!-- Conversations no agent entry owns — a plain chat, or one whose entry is long gone.
                         Nothing to draw a provider mark or a status for; the title and the matched line are
                         the whole of what is known about them. -->
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
            </template>
        </div>
        <!-- A failed rename already reverted the title; this says why. Cleared by the next rename. -->
        <span v-if="edit.error !== undefined" class="min-w-0 shrink truncate text-2xs text-danger" v-tooltip.bottom.overflow="edit.error">{{
            edit.error
        }}</span>
        <!-- Docked: the ✚ / history pair beside the strip, unchanged — a header row has width to spare and no
             room for two labels. Neither ever scrolls with the tabs. -->
        <div v-if="!vertical" class="flex shrink-0 items-center gap-1">
            <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="startAgent" v-tooltip.bottom="'New agent'" aria-label="New agent">
                <Icon name="plus" class="text-sm" />
            </button>
            <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="openHistory" v-tooltip.bottom="'History'" aria-label="Chat history">
                <Icon name="history" class="text-sm" />
            </button>
        </div>
        <!-- FOOT OF THE RAIL: the two ways out of the list — one more session, or an older one. Both stay where
             the ✚ / history pair has always been, at the bottom of the rail, because that is where the pointer
             already is: the composer it is about to type into sits directly to the right, and the window's
             bottom-left CORNER is an infinite-height target (Fitts) that a row at the top can never be. What
             was wrong was never the position, it was the weight — two unlabelled 28px glyphs of equal rank,
             reading as leftover toolbar rather than as "start a session".
             So the foot keeps the slot and spends the rail's width on saying what the controls do, ranked:
             browsing the archive is the quiet ghost row, and the primary act is a full-width filled button
             wearing the fleet board's own fill, glyph and wording — one "New agent" across the product. It
             takes the last row on purpose, hard against the corner, closest to the hand.
             Note the division of labour with the filter at the top: typing SEARCHES past the open tabs already
             (the "Not open" group), so History is for BROWSING — recent chats, newest first, nothing typed. -->
        <div v-else class="flex shrink-0 flex-col gap-1 border-t border-line pt-1">
            <button
                type="button"
                class="composer-ghost w-full justify-start gap-2 px-2 py-1.5 text-2xs"
                @click="openHistory"
                aria-label="Chat history"
            >
                <Icon name="history" class="text-2xs" />
                <span>Past chats…</span>
            </button>
            <button type="button" :class="cmp.buttonPrimary('w-full justify-center gap-1.5 px-2.5 py-1.5 text-2xs')" @click="startAgent">
                <Icon name="plus" class="text-2xs" />New agent
            </button>
        </div>
        <Popover ref="history" :append-to="overlayTarget" @show="searchInput?.focus()">
            <div class="flex w-72 flex-col">
                <div class="relative p-1">
                    <Icon
                        name="search"
                        aria-hidden="true"
                        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                    />
                    <input
                        ref="searchInput"
                        v-model="query"
                        type="text"
                        placeholder="Search chats…"
                        class="w-full min-w-0 rounded-md border border-line bg-canvas py-1 pl-7 pr-7 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                        @keydown.esc="query = ``"
                    />
                    <button
                        v-if="query"
                        type="button"
                        class="absolute right-3 top-1/2 flex -translate-y-1/2 items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                        v-tooltip.bottom="'Clear (Esc)'"
                        aria-label="Clear search"
                        @click="query = ``"
                    >
                        <Icon name="times" />
                    </button>
                </div>
                <div class="scrollbar-thin flex max-h-80 flex-col gap-0.5 overflow-auto p-1 pt-0">
                    <template v-if="sessions.length > 0">
                        <button
                            v-for="session in sessions"
                            :key="session.id"
                            type="button"
                            class="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-content/5"
                            @click="
                                emit('open', session.id);
                                history?.hide();
                            "
                        >
                            <span class="flex items-center gap-1.5">
                                <span class="min-w-0 flex-1 truncate text-xs text-content">{{ session.title }}</span>
                                <!-- Members with this session open right now. -->
                                <PresenceAvatars :viewers="viewersOfSession(session.id)" label="in this chat" />
                            </span>
                            <!-- Why this row matched, when it wasn't the title: the line of the user's own
                                 prompt the query hit. Same rule and same evidence as the rail's filter, so the
                                 two boxes in this one window can't come to mean different things. -->
                            <span v-if="session.snippet !== undefined" class="line-clamp-2 text-2xs italic text-muted">{{ session.snippet }}</span>
                            <span class="text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
                        </button>
                    </template>
                    <p v-else class="px-2 py-3 text-center text-2xs text-subtle">{{ query ? "No matching chats." : "No previous chats." }}</p>
                </div>
            </div>
        </Popover>
    </component>
    <!-- Full title (+ first message) on tab hover. Mounted at the overlay target so it clears the strip's
         overflow-auto clipping, and into the pop-out window while the chat floats there. -->
    <HoverCard ref="hoverCard" :to="overlayTarget" />

    <!-- Right-click menu, for a tab and for the strip's empty space alike. Rendered into the pop-out window while
         the chat floats there (`append-to`), with the same dense pt and shortcut-hint row the workspace's file-tab
         menu uses — one tab menu, two strips. -->
    <ContextMenu
        ref="tabMenu"
        :model="tabMenuItems"
        :append-to="overlayTarget"
        :pt="{
            root: '!min-w-52 !text-xs',
            rootList: '!p-1',
            itemLink: '!flex !items-center !gap-2 !rounded !px-2 !py-1 !text-xs',
            separator: '!my-1',
        }"
    >
        <!-- A reserved icon column keeps labels aligned whether or not the item carries an icon; the shortcut sits
             right-aligned, filled from the command registry (blank until the command is bound). -->
        <template #item="{ item, props }">
            <a v-bind="props.action">
                <span class="flex w-3.5 shrink-0 justify-center">
                    <Icon v-if="item.icon" :name="item.icon as IconName" class="text-2xs" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                <kbd
                    v-if="item['shortcut']"
                    class="shrink-0 rounded border border-line bg-overlay px-1 py-px font-mono text-[0.65rem] leading-none text-muted"
                    >{{ item["shortcut"] }}</kbd
                >
            </a>
        </template>
    </ContextMenu>
</template>

<style scoped>
/* The rail card's surface — AgentCard's skin (visible border, distinct fill) over .chat-tab's behaviour.
 * The docked strip's transparent pills blend into one column when stacked; a bordered card is what makes
 * each session a countable thing. Scoped selectors outweigh chat.css's single-class rules, so these win
 * without !important. */
.rail-card {
    border-color: var(--color-line);
    background: color-mix(in srgb, var(--color-canvas) 45%, transparent);
}
.rail-card:hover {
    border-color: var(--color-line-strong);
}
/* The active card is the one the transcript beside the rail is showing — the board marks its focused card
 * with a primary border, and this is the same fact on the same design. */
.rail-card.chat-tab-on {
    border-color: color-mix(in srgb, var(--color-primary-500) 70%, transparent);
}
/* Attention wears a warning border (the board's lane treatment), unless the card is also the active one —
 * "you are here" outranks "this needs you", since being here is how it gets dealt with. */
.rail-card-attention:not(.chat-tab-on) {
    border-color: color-mix(in srgb, var(--color-warning) 50%, transparent);
}

/* Drag-to-resize handle on the rail's right edge (pointer-capture, mirrors the panel's .resize-handle). */
.rail-resize {
    position: absolute;
    inset: 0 0 0 auto;
    width: 6px;
    cursor: col-resize;
    z-index: 20;
    touch-action: none;
    transition: background-color 0.15s;
}
.rail-resize:hover,
.rail-resizing .rail-resize {
    background: color-mix(in srgb, var(--color-primary-500) 35%, transparent);
}
.rail-resizing {
    user-select: none;
}
</style>

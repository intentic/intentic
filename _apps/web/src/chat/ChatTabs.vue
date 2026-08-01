<script setup lang="ts">
import { AnchoredOverlay, cmp, ContextMenu } from "@intentic-app/ui";
import type { Disposable } from "@intentic/extension-api";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { startAgent } from "../composables/agents/agentActions";
import { turnInFlight } from "../composables/agents/agentStatus";
import { createTitleEdit } from "../composables/agents/titleEdit";
import { useAgents } from "../composables/agents/useAgents";
import OriginMark from "../components/OriginMark.vue";
import { statusIcon, statusLabel, statusTabClass } from "../composables/chat/catalog";
import { allTabs, finishedTabs, isArchived, laneOfTab, originOf, othersOf, tabLabel, toRightOf } from "../composables/chat/tabs";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { inTabSurface } from "../composables/commands/tabSurface";
import { commandShortcut, registerCommand, type RegisteredCommand, withShortcut } from "../composables/commands/useCommands";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";
import ChatTabList from "./ChatTabList.vue";
import PastChatList from "./PastChatList.vue";

/* THE CHAT PANEL'S OWN BAR — one line that says which conversation you are in, and drops the list of every
 * other one on click. Docked it is a header across the top of the chat column; popped out it stands up the
 * window's left edge as a rail, with that same list permanently open in it.
 *
 * IT USED TO BE A TAB STRIP, and the strip was the wrong shape for this column. Tabs wrapped to a second row
 * and then scrolled, so a fleet of a dozen showed two or three truncated titles ("Migrate the users tab…",
 * "Migrate the users tab…" — derived titles share their prefixes), the rows reflowed on every open and close
 * so no tab kept its place, and the whole thing cost up to 96px of the narrowest column in the app to be a
 * strictly worse version of the switcher /agents already is. What the strip really earned was the other two
 * jobs: saying which chat the transcript below belongs to, and being the one place outside /agents that knows
 * you have other sessions running at all. Both fit on one 2.25rem line — the same line mobile has always used
 * — with the counts as marks (`spinner 2`, `! 1`) rather than as three shrunken titles.
 *
 * So the switcher wears: status glyph · origin · title · viewers · running / attention counts · chevron. The
 * list it opens is ChatTabList, the fleet board's three lanes in miniature — the same component the rail
 * shows, so the docked sheet and the pop-out rail cannot drift apart.
 *
 * The strip reads the conversation list from the useChat singleton and emits select / close / open rather
 * than writing it: this bar is a view of the tabs, and the panel it lives in is what hands each verb to the
 * store. "New agent" is not one of them: it means the same thing here as on the fleet board, so both call the
 * one startAgent action (agents/agentActions.ts) instead of each surface assembling its own half of it. */

const emit = defineEmits<{
    select: [id: string];
    // A SET, not an id: a card's × closes one, the menus close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, active, activeId, sessions, loadSessions } = useChat();
const { agentById } = useAgents();
const { poppedOut, toggle: togglePopout, overlayTarget } = useChatPopout();
// The toolbar button's tooltip AND its accessible name, one string: the control the pointer finds is what
// teaches the chord that makes the trip unnecessary. Docked-only, so it never has to say the way back.
const popoutHint = computed(() => withShortcut(`Move chat into new window`, `chat.togglePopout`));

/* Undocked, the bar stands up the window's LEFT EDGE as a resizable rail with the chat list always open in
 * it. A pop-out window is as wide as the user drags it, so a top bar there would spend the one axis the chat
 * is short of (height) on a row that has width to burn — while a rail has room to be a slice of the fleet
 * board. Docked, the chat column is ~22rem: a permanent rail there would halve the transcript, so the list
 * lives in a sheet the header drops and takes back. */
const vertical = computed(() => poppedOut.value);

/* --- The counts the header carries -------------------------------------------------------------
 * The one thing the strip did that /agents cannot: from inside the workspace, a terminal or settings, say
 * that other sessions are alive. Two numbers, over the chats open in THIS window (the set this bar switches
 * between) — how many are working, and how many have stopped to ask you something. Each is absent at zero, so
 * a quiet fleet leaves a quiet header and the marks mean something when they do appear. */
const runningCount = computed(
    () =>
        conversations.value.filter((conversation) => {
            const agent = agentById(conversation.conversationId);
            return agent !== undefined ? turnInFlight(agent) : conversation.streaming.value;
        }).length,
);
const attentionCount = computed(
    () => conversations.value.filter((conversation) => laneOfTab(conversation, agentById(conversation.conversationId)) === `attention`).length,
);

/* --- The sheet ---------------------------------------------------------------------------------
 * Docked, the list drops out of the header as a panel pinned to the chat column's own width — the shape the
 * composer's pickers already use (see ComposerPopover), and for the same reason: this is not a menu hanging
 * off a small trigger with room to flip around, it is a sheet the width of the column it belongs to. It also
 * keeps the row menus working, which an <AnchoredOverlay> would not: that closes on any pointerdown outside
 * its own box, and a right-click menu is teleported outside by construction — so choosing "Rename" would
 * dismiss the sheet a beat before the row it renames could show its input.
 *
 * Dismissal is therefore ours: Escape, a second press on the header, picking a chat, or a pointerdown outside
 * the header — except inside an open context menu, which is the one "outside" that is still this sheet. */
const listOpen = ref(false);
// The sheet is a child of the bar, so one ref answers both "is this click ours" and "which document are we in".
const bar = ref<HTMLElement | null>(null);
// The rail's list, for the one thing the host has to reach into it for — see the rename command below.
const rail = ref<InstanceType<typeof ChatTabList> | null>(null);

const onDocumentPointerDown = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) {
        return;
    }
    if (bar.value?.contains(target) === true || (target instanceof Element && target.closest(`.p-contextmenu`) !== null)) {
        return;
    }
    listOpen.value = false;
};
const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        listOpen.value = false;
    }
};
// Armed on the bar's OWN document, so a docked panel and a popped-out one can never listen in the wrong window.
let armedDocument: Document | undefined;
const disarmSheet = (): void => {
    armedDocument?.removeEventListener(`pointerdown`, onDocumentPointerDown, true);
    armedDocument?.removeEventListener(`keydown`, onDocumentKeydown);
    armedDocument = undefined;
};
watch(listOpen, (open) => {
    disarmSheet();
    if (!open) {
        return;
    }
    armedDocument = bar.value?.ownerDocument;
    // Capture, so a panel that stops its own clicks from bubbling cannot also stop this from closing.
    armedDocument?.addEventListener(`pointerdown`, onDocumentPointerDown, true);
    armedDocument?.addEventListener(`keydown`, onDocumentKeydown);
});
onBeforeUnmount(disarmSheet);

// Picking from the sheet is the end of the errand: switch, and give the column back to the transcript. The
// rail is not a sheet and stays put — out there the list IS the surface.
const pick = (id: string): void => {
    listOpen.value = false;
    emit(`select`, id);
};
const pickNotOpen = (id: string): void => {
    listOpen.value = false;
    emit(`open`, id);
};

/* --- Renaming the active chat --------------------------------------------------------------------
 * The header's title is the rename surface for the chat you are IN (F2, the app-wide rename key, and the
 * header's own double-click); a card in the list renames itself in place, where the pointer already is. Same
 * createTitleEdit both times, so a chat renamed on either surface renames its agent registry entry too. */
const renaming = ref(false);
const edit = createTitleEdit(
    () => active.value.conversationId,
    () => active.value.title.value ?? undefined,
);
const beginRename = (): void => {
    renaming.value = true;
    edit.begin();
};
// The input is torn down by the edit's own end (commit, cancel, blur), not by a second flag to keep in sync.
watch(
    () => edit.editing,
    (editing) => {
        if (!editing) {
            renaming.value = false;
        }
    },
);

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

/* The history panel and WHICH button it is hanging off — the docked header's glyph or the rail's "Past chats…"
 * row, whichever was pressed. The anchor is also what decides the window it opens in (AnchoredOverlay derives
 * document, viewport and dismissal from it), and those two buttons live in different ones: the rail's is in the
 * pop-out window, the header's in the app. */
const historyOpen = ref(false);
const historyAnchor = ref<HTMLElement>();
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

/* --- Right-click menu on the bar's chrome ----------------------------------------------------------
 * A right-click anywhere on this bar that isn't a text field opens the sweeps that name no particular chat
 * (Close Finished, Close All, the pop-out toggle) rather than popping the chat out on the spot — an
 * accidental right-click near the header shouldn't tear the panel into its own window. A CARD's menu is the
 * list's own and acts on the card under the pointer; this one is the chrome's, and the keyboard commands
 * below act on the ACTIVE chat — the split the workspace's file tabs make. */
const barMenu = ref<{ show: (event: Event) => void } | undefined>();
const barMenuItems = computed<MenuItem[]>(() => [
    {
        label: `Close Finished`,
        disabled: finishedTabs().size === 0,
        shortcut: commandShortcut(`chat.closeFinishedTabs`),
        command: () => emit(`close`, finishedTabs()),
    },
    { label: `Close All`, shortcut: commandShortcut(`chat.closeAllTabs`), command: () => emit(`close`, allTabs()) },
    { separator: true },
    {
        label: poppedOut.value ? `Dock chat back` : `Move chat into new window`,
        shortcut: commandShortcut(`chat.togglePopout`),
        command: togglePopout,
    },
]);
const onBarContextMenu = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest(`input, textarea`) !== null) {
        return; // a text field keeps the browser's own editing menu (the rename box, the list's filter)
    }
    event.preventDefault();
    barMenu.value?.show(event);
};

/* --- Commands ------------------------------------------------------------------------------------
 * Registered while THIS bar is mounted — the desktop bar and the mobile one are exclusive, so the ids can't
 * double-register.
 *
 * Every chord here is the SHELL-WIDE tab family (tabSurface.ts): the same Ctrl+Shift+{X , . Backspace} the
 * workspace's file tabs carry and the same Alt+PageUp/PageDown cycling, claimed only while the focus is inside
 * the chat panel. Two surfaces are on screen at once, so one chord per verb resolved by focus beats two chords
 * per verb memorized — it's what F2/rename has always done here. Each is rebindable in Settings →
 * Keybindings, per surface: remapping Close Chat leaves Close Tab where it was.
 *
 * They all act on the ACTIVE chat, which is the one this header names. Cycling emits `select` rather than
 * writing activeId, so it takes the same road as a click on a card: through the panel, which routes it to the
 * store's one writer of the tab list and of the focus (see useChat.setActive). */
let commandDisposables: readonly Disposable[] = [];
const cycleTab = (delta: number): void => {
    const list = conversations.value;
    if (list.length < 2) {
        return;
    }
    const index = list.findIndex((conversation) => conversation.conversationId === activeId.value);
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
                // Renamed where the user can see it happen: the header line docked, and the active card itself
                // out in the rail, which has no header to put an input in.
                if (vertical.value) {
                    rail.value?.beginRename(activeId.value);
                    return;
                }
                beginRename();
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
                const finished = finishedTabs();
                if (finished.size > 0) {
                    emit(`close`, finished);
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
        {
            // Unbound by default, like Close Finished: every chord this surface could claim is either taken
            // (Mod+Shift+P is the palette this command is reached FROM) or worth more to the file tabs. The
            // pointer trip is one click on a header that is always on screen.
            command: `chat.switchTab`,
            title: `Switch Chat…`,
            icon: `comments`,
            when: inTabSurface(`chat`),
            handler: (): void => {
                if (vertical.value) {
                    return; // the rail is already the list — there is nothing to open
                }
                listOpen.value = !listOpen.value;
            },
        },
    ];
    commandDisposables = entries.map((entry) => registerCommand({ owner: `builtin`, ...entry }));
});
onBeforeUnmount(() => {
    for (const disposable of commandDisposables) {
        disposable.dispose();
    }
    commandDisposables = [];
});

const openHistory = (event: Event): void => {
    query.value = ``;
    void loadSessions();
    historyAnchor.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    historyOpen.value = !historyOpen.value;
    if (historyOpen.value) {
        void nextTick(() => searchInput.value?.focus());
    }
};
</script>

<template>
    <!-- Docked: one line across the top of the chat column, with the list on a sheet beneath it. Undocked: a
         resizable rail down the window's left edge with the list always open, over a foot that carries the
         same ✚ / history pair the header wears beside it — there as two bare glyphs, here as a labelled
         "Past chats" row and a filled "New agent". -->
    <component
        :is="vertical ? 'aside' : 'header'"
        ref="bar"
        class="relative flex gap-1 border-line"
        :class="[
            vertical ? 'h-full shrink-0 flex-col items-stretch border-r p-1.5' : 'view-header items-center border-b px-1.5',
            { 'rail-resizing': railResizing },
        ]"
        :style="vertical ? { width: `${railWidth}px` } : undefined"
        @contextmenu="onBarContextMenu"
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

        <!-- THE SWITCHER. Docked only: the rail below already IS the list, and a header naming the active chat
             above it would say a third time what the ringed card and the transcript already say.
             Renaming REPLACES it rather than nesting a field inside it: an input in a button is neither valid
             markup nor a usable caret. Enter commits, Esc cancels, blur commits, an empty or unchanged name
             silently cancels — the WorkspaceTree convention, via createTitleEdit. -->
        <template v-if="!vertical">
            <input
                v-if="edit.editing && renaming"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                aria-label="Chat title"
                :placeholder="active.isolated.value ? 'New agent' : 'New chat'"
                class="h-7 min-w-0 flex-1 select-text rounded-md bg-overlay px-2 text-2xs text-content outline-none ring-1 ring-primary-500/50 placeholder:text-subtle"
                @keydown.enter.stop.prevent="edit.commit()"
                @keydown.esc.stop.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <button
                v-else
                type="button"
                data-chat-switcher
                class="chat-tab group flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-2xs"
                :class="{ 'chat-tab-on': listOpen }"
                :aria-expanded="listOpen"
                aria-haspopup="dialog"
                :aria-label="`Switch chat — ${conversations.length} open`"
                @click="listOpen = !listOpen"
                @dblclick.prevent.stop="beginRename()"
            >
                <!-- What THIS chat is doing, in the leading slot every surface gives it. Rendered for idle too
                     (a dim dot, not nothing) so the row's left edge never shifts as a turn starts and ends. -->
                <Icon v-bind="statusIcon(active.status.value)" :aria-label="statusLabel(active.status.value)" class="shrink-0" />
                <!-- Came in from outside (a Discord mention, a visitor, a webhook) rather than from you. -->
                <OriginMark :origin="originOf(active)" compact />
                <!-- Off the board, still open: the box glyph is the whole message, the same one the cards wear. -->
                <span v-if="isArchived(active)" class="flex shrink-0 items-center" aria-label="Archived">
                    <Icon name="box" class="text-2xs text-subtle" />
                </span>
                <span
                    class="min-w-0 flex-1 truncate text-left font-medium"
                    :class="statusTabClass(active.status.value)"
                    v-tooltip.bottom.overflow="tabLabel(active)"
                    >{{ tabLabel(active) }}</span
                >
                <!-- Members with this same conversation active right now. -->
                <PresenceAvatars
                    v-if="active.session.value !== undefined"
                    :members="viewersOfSession(active.session.value.id)"
                    label="in this chat"
                />
                <!-- THE OTHER SESSIONS, as two marks. This is the whole of what the old tab strip told you from
                     inside the workspace or a terminal, in the space one truncated title used to take. -->
                <span
                    v-if="runningCount > 0"
                    class="flex shrink-0 items-center gap-1 text-subtle"
                    :aria-label="`${runningCount} running`"
                    v-tooltip.bottom="`${runningCount} running`"
                >
                    <Icon name="spinner" spin class="text-2xs" />{{ runningCount }}
                </span>
                <span
                    v-if="attentionCount > 0"
                    class="flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 font-semibold text-warning"
                    :aria-label="`${attentionCount} need you`"
                    v-tooltip.bottom="`${attentionCount} waiting for you`"
                >
                    <Icon name="exclamation-circle" class="text-2xs" />{{ attentionCount }}
                </span>
                <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle transition-transform" :class="{ 'rotate-180': listOpen }" />
            </button>
        </template>

        <!-- THE RAIL'S LIST: always open, taking the height the window gives it. -->
        <ChatTabList
            v-if="vertical"
            ref="rail"
            class="min-h-0 flex-1"
            @select="emit('select', $event)"
            @close="emit('close', $event)"
            @open="emit('open', $event)"
        />

        <!-- Docked: the ✚ / history / pop-out trio beside the switcher — a header row has width to spare and no
             room for three labels.
             THE THIRD GLYPH IS THE POINT OF THIS BAR HAVING A TOOLBAR AT ALL. Moving the chat into its own
             window is a several-times-an-hour act for anyone running it beside an editor or on a second screen,
             and it used to live only behind a right-click on chrome the tabs kept eating. It sits last, hard
             against the window edge where window controls live, and its tooltip teaches F9 so the pointer trip
             is one a hand only has to make until it remembers. It is absent from the rail (which is already in
             the window this button opens — out there the way back is the window's own ×, F9, or the menu's
             "Dock chat back"). -->
        <div v-if="!vertical" class="flex shrink-0 items-center gap-1">
            <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="startAgent()" v-tooltip.bottom="'New agent'" aria-label="New agent">
                <Icon name="plus" class="text-sm" />
            </button>
            <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="openHistory" v-tooltip.bottom="'History'" aria-label="Chat history">
                <Icon name="history" class="text-sm" />
            </button>
            <button
                type="button"
                class="composer-ghost h-7 w-7 shrink-0"
                @click="togglePopout"
                v-tooltip.bottom="popoutHint"
                :aria-label="popoutHint"
            >
                <Icon name="external-link" class="text-sm" />
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
             Note the division of labour with the filter at the top of the list: typing SEARCHES past the open
             chats already (the "Not open" group), so History is for BROWSING — recent chats, newest first. -->
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
            <button type="button" :class="cmp.buttonPrimary('w-full justify-center gap-1.5 px-2.5 py-1.5 text-2xs')" @click="startAgent()">
                <Icon name="plus" class="text-2xs" />New agent
            </button>
        </div>

        <!-- THE SHEET. Pinned to the column's width under the header, capped so the transcript is never
             completely covered by the list of things it is one of. -->
        <div
            v-if="listOpen && !vertical"
            class="absolute inset-x-1.5 top-full z-30 mt-1 flex max-h-[60vh] flex-col overflow-hidden rounded-xl border border-line-strong bg-card p-1.5 shadow-lg"
        >
            <ChatTabList class="min-h-0 flex-1" @select="pick" @close="emit('close', $event)" @open="pickNotOpen" />
        </div>

        <!-- Anchored to whichever button was pressed, and capped by AnchoredOverlay to the room that button's
             own window has — the rail's trigger sits at the foot of the pop-out window, where the room above is
             whatever the user has dragged it to. The session list gives way; the search box holds its size. -->
        <AnchoredOverlay v-model="historyOpen" :anchor="historyAnchor" side="bottom">
            <div class="flex min-h-0 w-72 flex-col">
                <div class="relative shrink-0 p-1">
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
                <div class="scrollbar-thin flex min-h-0 max-h-80 flex-col gap-0.5 overflow-auto p-1 pt-0">
                    <PastChatList
                        :sessions="sessions"
                        :query="query"
                        @open="
                            emit(`open`, $event);
                            historyOpen = false;
                        "
                    />
                </div>
            </div>
        </AnchoredOverlay>

        <!-- Right-click menu for the bar's own chrome (the cards have their own, inside the list), rendered
             into the pop-out window while the chat floats there. -->
        <ContextMenu ref="barMenu" :model="barMenuItems" :append-to="overlayTarget" :min-width="13" />
    </component>
</template>

<style scoped>
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

<script setup lang="ts">
import Button from "primevue/button";
import { AnchoredOverlay, ContextMenu, SearchBar } from "@intentic/ui";
import type { Disposable } from "@intentic/extension-api";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { startAgent } from "../composables/agents/agentActions";
import { turnInFlight } from "../composables/agents/agentStatus";
import { localPosture } from "../environments/posture";
import { createInlineRename } from "../composables/inlineRename";
import { useAgents } from "../composables/agents/useAgents";
import OriginMark from "../components/OriginMark.vue";
import { statusIcon, statusLabel, statusTabClass } from "../composables/chat/catalog";
import { chatOnRail, chatWide, toggleChatHome, toggleChatPopout } from "../composables/chat/chatSurface";
import { allTabs, finishedTabs, isArchived, laneOfTab, originOf, othersOf, tabLabel, toRightOf } from "../composables/chat/tabs";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { commandShortcut, type CommandRegistration, registerCommand, withShortcut } from "../composables/commands/useCommands";
import { toAppPx, uiLength } from "../composables/uiScale";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";
import ChatTabList from "./ChatTabList.vue";
import PastChatList from "./PastChatList.vue";

/* THE CHAT PANEL'S OWN BAR — one line that says which conversation you are in, and drops the list of every
 * other one on click. Docked it is a header across the top of the chat column; popped out it stands up the
 * window's right edge as a rail, with that same list permanently open in it.
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

const { conversations, active, activeId, panes, openBeside, closePane, sessions, loadSessions } = useChat();
const { agentById, rename } = useAgents();
const { poppedOut, overlayTarget } = useChatPopout();
const router = useRouter();
// The toolbar button's tooltip AND its accessible name, one string: the control the pointer finds is what
// teaches the chord that makes the trip unnecessary. Never shown where the panel already floats, so it never
// has to say the way back.
const popoutHint = computed(() => withShortcut(`Move chat into new window`, `chat.togglePopout`));
// Its sibling on the docked header — moving the chat's home to the RAIL (a tile, full-window when opened).
// The ways back live on the tile itself (its right-click menu, ShellDesktop) and on this bar's own menu, so
// the rail form carries no window-management chrome of its own.
const railHint = computed(() => withShortcut(`Dock chat to rail — full window, behind a rail tile`, `chat.toggleHome`));
// Only where the /chat area exists to navigate to: the workspace shell, not a local-posture host window.
const canFill = localPosture() === undefined;

/* On a WIDE surface (the pop-out window, or the /chat area filling the main one) the bar stands up the RIGHT
 * EDGE as a resizable rail with the chat list always open in it (ChatPanel's row-reverse says why that side).
 * A wide surface has the width to keep the list open beside the transcript, and a top bar there would spend
 * the one axis the chat is short of (height) on a row that has width to burn — while a rail has room to be a
 * slice of the fleet board. Docked, the chat column is ~22rem: a permanent rail there would halve the
 * transcript, so the list lives in a sheet the header drops and takes back. */
const vertical = computed(() => chatWide.value);

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
 * createInlineRename both times, so a chat renamed on either surface renames its agent registry entry too. */
const renaming = ref(false);
const edit = createInlineRename(
    () => active.value.title.value ?? undefined,
    (name) => rename(active.value.conversationId, name),
    `Couldn't rename the agent.`,
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
// The rail resizes off its LEFT edge (pointer capture, double-click resets) — it stands at the right of every
// wide surface — and persists like the panel widths in useLayout, but locally, because it exists only in the
// wide forms. In app pixels for the same reason as those: the rail holds chat cards, so the width that fits
// their titles moves with the text size.
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
// The rail is flush with its window's RIGHT edge, so its width is the distance from the pointer to it — asked
// of the rail's OWN window, which is the pop-out's whenever the panel floats there.
const onRailResize = (event: PointerEvent): void => {
    if (railResizing.value) {
        const view = bar.value?.ownerDocument.defaultView ?? window;
        setRailWidth(toAppPx(view.innerWidth - event.clientX));
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

/* The history panel and WHICH button it is hanging off — the docked header's glyph or the rail's "Past chats"
 * button, whichever was pressed. The anchor is also what decides the window it opens in (AnchoredOverlay derives
 * document, viewport and dismissal from it), and those two buttons live in different ones: the rail's is in the
 * pop-out window, the header's in the app. */
const historyOpen = ref(false);
const historyAnchor = ref<HTMLElement>();
const searchInput = ref<InstanceType<typeof SearchBar> | null>(null);

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
    // The chat's other two homes, in the header buttons' order (move within this window, then leave it). The
    // dock row is the shell command's move (toggleChatHome — from a pop-out window it docks AND navigates,
    // which is exactly what those words ask for there) and is absent where the /chat area doesn't exist (a
    // local-posture host window).
    ...(canFill
        ? [
              {
                  label: chatOnRail.value ? `Dock chat back to the side` : `Dock chat to rail`,
                  shortcut: commandShortcut(`chat.toggleHome`),
                  command: (): void => toggleChatHome(router),
              },
          ]
        : []),
    {
        label: poppedOut.value ? `Dock chat back` : `Move chat into new window`,
        shortcut: commandShortcut(`chat.togglePopout`),
        // The routed toggle, not the bare one: docking back while the rail is home walks to the tile's area
        // instead of parking the chat out of sight (chatSurface.ts).
        command: (): void => toggleChatPopout(router),
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
// The chord's half of Open Beside: the first chat AFTER the focused one that isn't already in a column, else
// the first anywhere that isn't — so repeated presses fill the window rather than re-opening the same chat.
// Tab order, like cycleTab, since both answer "the next chat" and must not mean two different things.
const splitBeside = (): void => {
    if (!chatWide.value) {
        return;
    }
    const list = conversations.value;
    const index = list.findIndex((conversation) => conversation.conversationId === activeId.value);
    const free = (conversation: (typeof list)[number]): boolean => !panes.value.includes(conversation.conversationId);
    const next = list.slice(index + 1).find(free) ?? list.find(free);
    if (next !== undefined) {
        openBeside(next.conversationId);
    }
};
onMounted(() => {
    const entries: Omit<CommandRegistration, `owner`>[] = [
        {
            command: `chat.rename`,
            title: `Rename Chat…`,
            icon: `pencil`,
            keybinding: `F2`,
            when: `tabSurface == 'chat'`,
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
            when: `tabSurface == 'chat'`,
            handler: () => emit(`close`, new Set([activeId.value])),
        },
        {
            command: `chat.closeOtherTabs`,
            title: `Close Other Chats`,
            icon: `times`,
            keybinding: `Ctrl+Shift+,`,
            when: `tabSurface == 'chat'`,
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
            when: `tabSurface == 'chat'`,
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
            when: `tabSurface == 'chat'`,
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
            when: `tabSurface == 'chat'`,
            handler: () => emit(`close`, allTabs()),
        },
        { command: `chat.nextTab`, title: `Next Chat`, keybinding: `Alt+PageDown`, when: `tabSurface == 'chat'`, handler: () => cycleTab(1) },
        { command: `chat.previousTab`, title: `Previous Chat`, keybinding: `Alt+PageUp`, when: `tabSurface == 'chat'`, handler: () => cycleTab(-1) },
        {
            /* VSCode's split-editor chord doing the chat's version of it: give the next chat a column of its
             * own beside this one. NOT a second view of the same conversation, which is what VSCode splits to
             * — a chat carries a composer, and two of them writing into one transcript is a worse answer than
             * the question deserves. Wide surfaces only, where the width for a second column exists (ChatPanel). */
            command: `chat.splitView`,
            title: `Open Next Chat Beside`,
            keybinding: `Mod+\\`,
            when: `tabSurface == 'chat'`,
            handler: () => splitBeside(),
        },
        {
            // Unbound, like Close Finished: the verb is one press away on the row's own menu, and every chord
            // worth spending here is already spent. Takes the focused chat's column back — the chat stays open.
            command: `chat.closePane`,
            title: `Close Pane`,
            when: `tabSurface == 'chat'`,
            handler: () => closePane(activeId.value),
        },
        {
            // Unbound by default, like Close Finished: every chord this surface could claim is either taken
            // (Mod+Shift+P is the palette this command is reached FROM) or worth more to the file tabs. The
            // pointer trip is one click on a header that is always on screen.
            command: `chat.switchTab`,
            title: `Switch Chat…`,
            icon: `comments`,
            when: `tabSurface == 'chat'`,
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
         resizable rail down the window's right edge with the list always open, over a foot that carries the
         same ✚ / history pair the header wears beside it — there as two bare glyphs, here as a labelled
         "Past chats" row and a filled "New agent". -->
    <component
        :is="vertical ? 'aside' : 'header'"
        ref="bar"
        class="relative flex gap-1 border-line"
        :class="[
            vertical ? 'h-full shrink-0 flex-col items-stretch p-1.5' : 'view-header items-center border-b px-1.5',
            { 'rail-resizing': railResizing },
        ]"
        :style="vertical ? { width: uiLength(railWidth) } : undefined"
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
             silently cancels — the WorkspaceTree convention, via createInlineRename. -->
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

        <!-- Docked: the ✚ / history / dock-to-rail / pop-out run beside the switcher — a header row has width
             to spare and no room for labels.
             THE LAST TWO GLYPHS ARE THE POINT OF THIS BAR HAVING A TOOLBAR AT ALL: the chat's other two homes.
             The expand moves the chat's home to the RAIL (a tile, full-window when opened, no column beside
             other views); the pop-out moves it into its own window, a several-times-an-hour act for anyone
             running it beside an editor or on a second screen that used to live only behind a right-click on
             chrome the tabs kept eating. They sit last in that order — move within this window, then leave it —
             hard against the window edge where window controls live, and each tooltip teaches its command's
             chord so the pointer trip is one a hand only has to make until it remembers. Both are absent from
             the rail form (which is already one of the places they lead — out there the ways back are the
             Chat tile's own right-click menu, the window's ×, F9, or this bar's menu rows). -->
        <div v-if="!vertical" class="flex shrink-0 items-center gap-1">
            <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="startAgent()" v-tooltip.bottom="'New agent'" aria-label="New agent">
                <Icon name="plus" class="text-sm" />
            </button>
            <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="openHistory" v-tooltip.bottom="'History'" aria-label="Chat history">
                <Icon name="history" class="text-sm" />
            </button>
            <button
                v-if="canFill"
                type="button"
                class="composer-ghost h-7 w-7 shrink-0"
                @click="toggleChatHome(router)"
                v-tooltip.bottom="railHint"
                :aria-label="railHint"
            >
                <!-- A panel docked at the left edge — the rail — not `expand`, whose fullscreen glyph promised
                     a maximise this press doesn't do. -->
                <Icon name="layout-left" class="text-sm" />
            </button>
            <button
                type="button"
                class="composer-ghost h-7 w-7 shrink-0"
                @click="toggleChatPopout(router)"
                v-tooltip.bottom="popoutHint"
                :aria-label="popoutHint"
            >
                <Icon name="external-link" class="text-sm" />
            </button>
        </div>

        <!-- FOOT OF THE RAIL: the two ways out of the list — one more session, or an older one — as ONE
             centred row under it. Both controls are LABELLED, which is what the two 28px glyphs this
             replaced never were, and both are sized to their labels: stacked full-width rows made a footer
             slab, and at the rail's width the primary was exactly a card, wearing a tinted border in the
             same colour as the ring on the active card above it. Two competing rectangles, both chrome, in
             a window whose job is to be read. Rank is carried by the fill alone now — the primary keeps the
             fleet board's fill, glyph and wording (one "New agent" across the product), the archive is the
             quiet ghost beside it.
             CENTRED rather than pushed into the bottom-left corner. The corner is the better Fitts target
             and that is what this row was first built as, but a pair of small controls held against the
             left of a rail that can be dragged to 480px reads as two things left over at the end of a list
             — the width they are not using is the loudest thing about them. A band across the foot is what
             the eye expects under a column, and the filled button is a big enough target either way.
             The label says "Past chats", not "Past chats…": the ellipsis is the convention for "this opens
             a chooser", but beside a button that has none it reads as a truncated label rather than as a
             promise, which is exactly how it was read.
             No divider — that went with the border down the rail's right edge, since with no edge to end
             against a hairline over a half-empty column is a line to nowhere. Gaps hold this row off
             instead, and the one BELOW it is the point: the rail's own padding alone left a control sitting
             on the window's bottom edge. Both are ~1rem, so the row sits in a band of its own rather than
             at the end of the window.
             Note the division of labour with the filter at the top of the list: typing SEARCHES past the
             open chats already (the "Not open" group), so History is for BROWSING — newest first. -->
        <div v-else class="flex shrink-0 flex-wrap items-center justify-center gap-2 pb-2.5 pt-3">
            <Button size="small" @click="startAgent()"> <Icon name="plus" />New agent </Button>
            <button type="button" class="composer-ghost h-7 gap-1.5 px-2 text-2xs" @click="openHistory">
                <Icon name="history" class="text-2xs" />
                <span>Past chats</span>
            </button>
        </div>

        <!-- THE SHEET. Pinned to the column's width under the header, capped so the transcript is never
             completely covered by the list of things it is one of.
             ON CANVAS, not on the panel's card colour: the list draws its lanes as slabs mixed FROM canvas
             (`.lane`), so a host that paints anything else leaves them floating a shade off their own
             surroundings. The rail out in the pop-out window is a canvas body; this paints one. The strong
             edge and the shadow are what make it a sheet floating over the transcript — the fill was never
             carrying that. -->
        <div
            v-if="listOpen && !vertical"
            class="absolute inset-x-1.5 top-full z-30 mt-1 flex max-h-[60vh] flex-col overflow-hidden rounded-xl border border-line-strong bg-canvas p-1.5 shadow-lg"
        >
            <ChatTabList class="min-h-0 flex-1" @select="pick" @close="emit('close', $event)" @open="pickNotOpen" />
        </div>

        <!-- Anchored to whichever button was pressed, and capped by AnchoredOverlay to the room that button's
             own window has — the rail's trigger sits at the foot of the pop-out window, where the room above is
             whatever the user has dragged it to. The session list gives way; the search box holds its size. -->
        <AnchoredOverlay v-model="historyOpen" :anchor="historyAnchor" side="bottom">
            <div class="flex min-h-0 w-72 flex-col">
                <SearchBar
                    ref="searchInput"
                    v-model="query"
                    variant="field"
                    clearable
                    aria-label="Search chats"
                    placeholder="Search chats…"
                    class="m-1 shrink-0"
                />
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
/* Drag-to-resize handle on the rail's LEFT edge — the seam against the panes it stands beside (pointer-capture,
 * mirrors the panel's .resize-handle). */
.rail-resize {
    position: absolute;
    inset: 0 auto 0 0;
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

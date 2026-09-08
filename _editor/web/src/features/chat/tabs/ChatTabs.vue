<script setup lang="ts">
import { AnchoredOverlay, Button, ContextMenu, SearchBar } from "@intentic/ui";
import type { Disposable } from "@intentic/extension-api";
import type { MenuItem } from "primevue/menuitem";
import { type ComponentPublicInstance, computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import { turnInFlight } from "../../agents/fleet/agentStatus";
import { createInlineRename } from "../../../lib/inlineRename";
import { useAgents } from "../../agents/fleet/useAgents";
import OriginMark from "../../../components/OriginMark.vue";
import RailColumn from "../../../components/RailColumn.vue";
import { statusIcon, statusLabel, statusTabClass } from "../models/catalog";
import { chatOnRail, chatWide, toggleChatFloating, toggleChatHome } from "../panel/chatPanelLayout";
import { allTabs, isArchived, laneOfTab, originOf, othersOf, tabLabel, tabsInLane, toRightOf } from "./tabs";
import { useChat } from "../run/useChat";
import { useChatFloating } from "../panel/chatFloating";
import { commandShortcut, type CommandRegistration, registerCommand, withShortcut } from "../../../shell/commands/useCommands";
import { viewersOfSession } from "../../../shell/presence/usePresence";
import PresenceAvatars from "../../../shell/presence/PresenceAvatars.vue";
import ChatTabList from "./ChatTabList.vue";
import PastChatList from "../panel/PastChatList.vue";

// The chat panel's own bar: names the active conversation and drops the full list (ChatTabList) on click.
// Docked it's a header over a sheet; floating it's a rail with the list always open. Reads the conversation
// list from useChat and emits select/close/open rather than writing it.

const emit = defineEmits<{
    select: [id: string];
    // A SET, not an id: a card's × closes one, the menus close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, active, activeId, panes, openBeside, closePane, sessions, loadSessions, keepChat } = useChat();
const { agentById, rename } = useAgents();
const { floats } = useChatFloating();
const router = useRouter();
// Tooltip and accessible name in one string; hidden where the panel already floats.
const floatHint = computed(() => withShortcut(`Move chat into new window`, `chat.toggleFloating`));
// Moves the chat's home to the rail (a tile); return paths live on the tile itself and this bar's own menu.
const railHint = computed(() => withShortcut(`Dock chat to rail: full window, behind a rail tile`, `chat.toggleHome`));

// On a wide surface the bar stands up as a left rail with the list always open, trading width the chat has for
// the height it's short of. Docked (~22rem) is too narrow for a permanent rail, so the list lives in a sheet.
const vertical = computed(() => chatWide.value);

// The one thing the old strip did that /agents can't: say from elsewhere (a terminal, settings) that other
// chats are alive. Counts are over chats open in this window, and each mark disappears at zero.
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

// Not an AnchoredOverlay: that dismisses on any outside pointerdown, including the row menu's teleported
// target, before Rename shows its input. Closed by Escape, a second header press, a pick, or an outside click
// (context menus excepted).
const listOpen = ref(false);
// One ref answers both "is this click ours" and "which document"; null on the rail (no sheet there).
const bar = ref<HTMLElement | null>(null);
const setBar = (element: Element | ComponentPublicInstance | null): void => {
    bar.value = element instanceof HTMLElement ? element : null;
};
// The rail's list, reached only for the rename command below.
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
// Armed on the bar's own document, so a docked and a floating panel never listen in the wrong window.
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
    // Capture, so a panel that stops its own bubbling can't also stop this from closing.
    armedDocument?.addEventListener(`pointerdown`, onDocumentPointerDown, true);
    armedDocument?.addEventListener(`keydown`, onDocumentKeydown);
});
onBeforeUnmount(disarmSheet);

// Picking from the sheet ends the errand: switch, then hand the column back to the transcript. The rail isn't
// a sheet and stays put.
const pick = (id: string): void => {
    listOpen.value = false;
    emit(`select`, id);
};
const pickNotOpen = (id: string): void => {
    listOpen.value = false;
    emit(`open`, id);
};

// The header title renames the chat you're in (F2, double-click); a list card renames itself in place. Both
// use createInlineRename, so either renames the agent registry entry too.
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
// The input is torn down by the edit's own end (commit/cancel/blur), not a second flag kept in sync.
watch(
    () => edit.editing,
    (editing) => {
        if (!editing) {
            renaming.value = false;
        }
    },
);
// The field names the chat it opened on: another window's summons switches chats without blurring it, and the
// commit would then land on whichever chat is active by then.
watch(activeId, () => {
    if (edit.editing) {
        edit.cancel();
    }
});

// Anchored to whichever button opened it (docked header glyph or rail's "Past chats"); the anchor also picks
// the window it opens in, since AnchoredOverlay derives document and viewport from it.
const historyOpen = ref(false);
const historyAnchor = ref<HTMLElement>();
const searchInput = ref<InstanceType<typeof SearchBar> | null>(null);

// Filters sessions by title or content (server-side); debounced so a keystroke burst becomes one request.
const query = ref(``);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadSessions(value.trim() || undefined), 200);
});
onBeforeUnmount(() => clearTimeout(searchTimer));

// Right-click on the bar's chrome opens window-wide sweeps (Close Finished/All, pop-out), not a pop-out on the
// spot. A card's own menu acts on that card; this one and the keyboard commands act on the active chat.
const barMenu = ref<{ show: (event: Event) => void } | undefined>();
const barMenuItems = computed<MenuItem[]>(() => [
    {
        label: `Close Finished`,
        disabled: tabsInLane(`finished`).size === 0,
        shortcut: commandShortcut(`chat.closeFinishedTabs`),
        command: () => emit(`close`, tabsInLane(`finished`)),
    },
    { label: `Close All`, shortcut: commandShortcut(`chat.closeAllTabs`), command: () => emit(`close`, allTabs()) },
    { separator: true },
    // The chat's other two homes, in the header buttons' own order: move within this window, then leave it.
    {
        label: chatOnRail.value ? `Dock chat back to the side` : `Dock chat to rail`,
        shortcut: commandShortcut(`chat.toggleHome`),
        command: (): void => toggleChatHome(router),
    },
    {
        label: floats.value ? `Dock chat back` : `Move chat into new window`,
        shortcut: commandShortcut(`chat.toggleFloating`),
        command: (): void => toggleChatFloating(),
    },
]);
const onBarContextMenu = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest(`input, textarea`) !== null) {
        return; // A text field keeps the browser's own editing menu (the rename box, the list's filter).
    }
    event.preventDefault();
    barMenu.value?.show(event);
};

// Registered while this bar is mounted (desktop/mobile are exclusive). Uses the shell-wide tab chords, all
// acting on the active chat; cycling emits `select`, the same path a card click takes.
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
// Chord half of Open Beside: the next chat after the focused one not already in a column, else the first free
// one, so repeats fill the window instead of reopening one chat.
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
                    return; // Already renaming; a second F2 would wipe the draft.
                }
                // Renamed where it's visible: the header docked, or the active card on the rail (no header there).
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
            // Unbound by default, no file-tab equivalent for "finished"; still reachable via the palette and
            // Keybindings.
            command: `chat.closeFinishedTabs`,
            title: `Close Finished Chats`,
            icon: `times`,
            when: `tabSurface == 'chat'`,
            handler: (): void => {
                const finished = tabsInLane(`finished`);
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
            // VSCode's split chord for a different chat, not a second view: a chat carries its own composer.
            command: `chat.splitView`,
            title: `Open Next Chat Beside`,
            keybinding: `Mod+\\`,
            when: `tabSurface == 'chat'`,
            handler: () => splitBeside(),
        },
        {
            // Unbound, like Close Finished, reachable from the row menu; takes back the column, the chat stays open.
            command: `chat.closePane`,
            title: `Close Pane`,
            when: `tabSurface == 'chat'`,
            handler: () => closePane(activeId.value),
        },
        {
            // Unbound: every free chord here is already spent, and the header is one click away regardless.
            command: `chat.switchTab`,
            title: `Switch Chat…`,
            icon: `comments`,
            when: `tabSurface == 'chat'`,
            handler: (): void => {
                if (vertical.value) {
                    return; // The rail is already the list; there's nothing to open.
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
    <!--
        Docked: one line across the column top, with the list on a sheet below it. Undocked: a resizable left rail
        with the list always open, over a foot carrying the same +/history pair as labelled rows.
    -->
    <!--
        The rail form isn't drawn here: RailColumn is the shared column shell every agent list stands in, keeping
        this rail and /subagents' in step.
    -->
    <component
        :is="vertical ? RailColumn : 'header'"
        :ref="setBar"
        :class="vertical ? undefined : 'view-header relative flex items-center gap-1 border-b border-line px-1.5'"
        @contextmenu="onBarContextMenu"
    >
        <!--
            The switcher, docked only — the rail below already is the list. Renaming replaces it rather than nesting a
            field in it: Enter/blur commit, Esc cancels, an empty or unchanged name silently cancels (createInlineRename).
        -->
        <template v-if="!vertical">
            <input
                v-if="edit.editing && renaming"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                aria-label="Chat title"
                :placeholder="active.isolated.value ? 'New agent' : 'New chat'"
                class="ui-field-box ui-field-inline h-7 min-w-0 flex-1 select-text px-2 text-2xs"
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
                :aria-label="`Switch chat: ${conversations.length} open`"
                @click="listOpen = !listOpen"
                @dblclick.prevent.stop="beginRename()"
            >
                <!-- What this chat is doing; rendered (dim) even when idle so the row's left edge never shifts. -->
                <Icon v-bind="statusIcon(active.status.value)" :aria-label="statusLabel(active.status.value)" class="shrink-0" />
                <!-- Came in from outside (a Discord mention, a visitor, a webhook) rather than from you. -->
                <OriginMark :origin="originOf(active)" compact />
                <!-- Off the board but still open; the box glyph is the same one the cards wear. -->
                <span v-if="isArchived(active)" class="flex shrink-0 items-center" aria-label="Archived">
                    <Icon name="box" class="text-2xs text-subtle" />
                </span>
                <!--
                    Italic while this chat is only being looked at (Conversation.peek), the same mark the rail cards and the
                    workspace preview tab wear. Kept by the pin button below.
                -->
                <span
                    class="min-w-0 flex-1 truncate text-left font-medium"
                    :class="[statusTabClass(active.status.value), { italic: active.peek.value }]"
                    v-tooltip.bottom.overflow="tabLabel(active)"
                    >{{ tabLabel(active) }}</span
                >
                <!-- Members with this same conversation active right now. -->
                <PresenceAvatars
                    v-if="active.session.value !== undefined"
                    :members="viewersOfSession(active.session.value.id)"
                    label="in this chat"
                />
                <!-- The other sessions (running, attention) as two compact marks instead of a truncated title. -->
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

        <!-- The rail's list: always open, filling the height the window gives it. -->
        <ChatTabList
            v-if="vertical"
            ref="rail"
            class="min-h-0 flex-1"
            @select="emit('select', $event)"
            @close="emit('close', $event)"
            @open="emit('open', $event)"
        />

        <!--
            Docked toolbar: new chat, history, then the chat's other two homes (dock to rail, pop out to a window) in
            that order — move within the window, then leave it. Tooltips name each chord; absent on the rail, which
            already leads to both.
        -->
        <div v-if="!vertical" class="flex shrink-0 items-center gap-1">
            <!--
                Shown only while there's something to keep: the docked column has no card of its own to carry the rail's
                pin. Disappears once the chat is kept, by this press or anything else in it.
            -->
            <button
                v-if="active.peek.value"
                type="button"
                class="composer-ghost h-7 w-7 shrink-0"
                @click="keepChat(active.conversationId)"
                v-tooltip.bottom="'Keep open, otherwise this chat closes when you open another'"
                aria-label="Keep this chat open"
            >
                <Icon name="pin" class="text-sm" />
            </button>
            <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="startAgent()" v-tooltip.bottom="'New agent'" aria-label="New agent">
                <Icon name="plus" class="text-sm" />
            </button>
            <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="openHistory" v-tooltip.bottom="'History'" aria-label="Chat history">
                <Icon name="history" class="text-sm" />
            </button>
            <button
                type="button"
                class="composer-ghost h-7 w-7 shrink-0"
                @click="toggleChatHome(router)"
                v-tooltip.bottom="railHint"
                :aria-label="railHint"
            >
                <!-- A rail docked at the left edge, not `expand`, whose glyph would promise a maximise this press doesn't do. -->
                <Icon name="layout-left" class="text-sm" />
            </button>
            <button
                type="button"
                class="composer-ghost h-7 w-7 shrink-0"
                @click="toggleChatFloating()"
                v-tooltip.bottom="floatHint"
                :aria-label="floatHint"
            >
                <Icon name="external-link" class="text-sm" />
            </button>
        </div>

        <!--
            Foot of the rail: New agent (the fleet board's own wording) and Past chats, labelled and sized to match, no
            ellipsis (there's no chooser to promise). The list's own filter already searches open chats; this browses
            history, newest first.
        -->
        <div v-else class="flex shrink-0 flex-wrap items-center justify-center gap-2 pb-2.5 pt-3">
            <Button size="small" @click="startAgent()"> <Icon name="plus" />New agent </Button>
            <button type="button" class="composer-ghost h-7 gap-1.5 px-2 text-2xs" @click="openHistory">
                <Icon name="history" class="text-2xs" />
                <span>Past chats</span>
            </button>
        </div>

        <!--
            Pinned to the column's width, capped so the transcript is never fully covered. Painted on canvas, matching
            the rail's own body, since the list's lanes are slabs mixed from canvas (`.lane`).
        -->
        <div
            v-if="listOpen && !vertical"
            class="lane-ground-canvas absolute inset-x-1.5 top-full z-30 mt-1 flex max-h-[60vh] flex-col overflow-hidden rounded-xl border border-line-strong bg-canvas p-1.5 shadow-lg"
        >
            <ChatTabList class="min-h-0 flex-1" @select="pick" @close="emit('close', $event)" @open="pickNotOpen" />
        </div>

        <!--
            Anchored to whichever button was pressed; AnchoredOverlay caps it to that button's own window. The session
            list yields room; the search box keeps its size.
        -->
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

        <!-- Right-click menu for the bar's own chrome; cards have their own, inside the list. -->
        <ContextMenu ref="barMenu" :model="barMenuItems" :min-width="13" />
    </component>
</template>

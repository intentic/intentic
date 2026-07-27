<script setup lang="ts">
import type { IconName } from "@intentic-app/ui";
import type { Disposable } from "@intentic/extension-api";
import type { AgentOrigin } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import ContextMenu from "primevue/contextmenu";
import Dialog from "primevue/dialog";
import type { MenuItem } from "primevue/menuitem";
import Popover from "primevue/popover";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { startAgent } from "../composables/agents/agentActions";
import { createTitleEdit } from "../composables/agents/titleEdit";
import { useAgents } from "../composables/agents/useAgents";
import OriginMark from "../components/OriginMark.vue";
import { relativeTime, statusTabClass } from "../composables/chat/catalog";
import type { Conversation } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { commandShortcut, registerCommand, type RegisteredCommand } from "../composables/commands/useCommands";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";

/* The tab strip + history menu. Reads the conversation list from the useChat singleton; the panel owns the
 * side effects of SWITCHING (scroll pinning), so select/close/open are emitted rather than applied. "New
 * agent" is not one of them: it means the same thing here as on the fleet board, so both call the one
 * startAgent action (agents/agentActions.ts) instead of each surface assembling its own half of it. */

const emit = defineEmits<{
    select: [id: string];
    // A SET, not an id: the tab × closes one, the right-click menu's Close Others / to the Right / All close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, sessions, loadSessions } = useChat();
const { agentById } = useAgents();
const { supported: popoutSupported, poppedOut, toggle: togglePopout, overlayTarget } = useChatPopout();

// What a tab (and the confirm dialog's list) calls a conversation: its derived title, else the noun for where it
// works — an untitled isolated conversation IS a draft agent card on the fleet board.
const tabLabel = (conversation: Conversation): string => conversation.title.value ?? (conversation.isolated.value ? `New agent` : `New chat`);

// Which tabs were opened by an outside message rather than by the user (the registry entry is where that
// fact lives, so it's read from the fleet). The strip wears the source glyph alone — the title of such a tab
// already leads with who sent the message.
const originOf = (conversation: Conversation): AgentOrigin | undefined => agentById(conversation.conversationId)?.origin;

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
const renaming = computed(() => conversations.value.find((conversation) => conversation.id === renamingId.value));
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
// A compact card that reveals a tab's FIRST message IN FULL, standing in for the terse title tooltip (which only
// ever repeats the 40-char header). It teleports to the overlay target (the pip body while popped out, else
// <body>) so it escapes the tab strip's overflow-auto clipping, and flips above/below the tab depending on the
// room in that window — the same floating-preview idiom as the image attachments.
const preview = ref<{ text: string; left: number; top?: number; bottom?: number }>();

const PREVIEW_WIDTH = 320; // px — matches the card's max-w below.
const PREVIEW_GAP = 8;

const showPreview = (event: MouseEvent, conversation: Conversation): void => {
    const firstUser = conversation.messages.value.find((message) => message.role === `user`);
    const text = (firstUser && firstUser.text.trim() !== `` ? firstUser.text : conversation.title.value) ?? ``;
    if (text.trim() === ``) return; // a fresh "New chat"/"New agent" tab has no first message to preview.
    const el = event.currentTarget as HTMLElement;
    // The tab may live in the pip window, whose viewport (and fixed-position origin) is its own — measure and
    // clamp against that window, not the main realm's globalThis.
    const win = el.ownerDocument.defaultView ?? globalThis;
    const rect = el.getBoundingClientRect();
    const left = Math.min(Math.max(PREVIEW_GAP, rect.left), win.innerWidth - PREVIEW_WIDTH - PREVIEW_GAP);
    // Anchor below the tab (the strip sits at the top, so there's room) and only flip above when there isn't.
    preview.value =
        rect.top >= win.innerHeight - rect.bottom
            ? { text, left, bottom: win.innerHeight - rect.top + PREVIEW_GAP }
            : { text, left, top: rect.bottom + PREVIEW_GAP };
};
const hidePreview = (): void => {
    preview.value = undefined;
};

// --- Closing ------------------------------------------------------------------------------------
// The close sets the strip can ask for, named the way the menu names them. Read off the live list from inside the
// menu's own computed, so a tab that arrives while the menu sits open (an inbound Discord mention opens one) is
// folded into the set rather than escaping a snapshot taken at right-click time.
const othersOf = (id: string): ReadonlySet<string> => new Set(conversations.value.filter((c) => c.id !== id).map((c) => c.id));
const toRightOf = (id: string): ReadonlySet<string> => {
    const index = conversations.value.findIndex((c) => c.id === id);
    return new Set(index === -1 ? [] : conversations.value.slice(index + 1).map((c) => c.id));
};
const allTabs = (): ReadonlySet<string> => new Set(conversations.value.map((c) => c.id));

// A bulk close waiting on the "this aborts running turns" confirm — the chat's answer to the workspace's
// unsaved-edits dialog. A single × (and the menu's "Close") stays silent: that tab is right there, pulsing if its
// agent is working. A background tab's running agent is exactly what's easy to miss, so the mass closes ask.
// Closing never destroys the conversation — it aborts the turn and drops the local transcript cache; the session
// itself stays in the sandbox's store, reopenable from the history menu.
const pendingClose = ref<ReadonlySet<string>>();
const runningIn = (ids: ReadonlySet<string>): readonly Conversation[] => conversations.value.filter((c) => ids.has(c.id) && c.streaming.value);
const pendingCloseRunning = computed(() => (pendingClose.value === undefined ? [] : runningIn(pendingClose.value)));
const requestClose = (ids: ReadonlySet<string>): void => {
    if (runningIn(ids).length === 0) {
        emit(`close`, ids);
        return;
    }
    pendingClose.value = ids;
};
const confirmClose = (): void => {
    if (pendingClose.value !== undefined) {
        emit(`close`, pendingClose.value);
    }
    pendingClose.value = undefined;
};

// --- Right-click tab menu -------------------------------------------------------------------------
// The same close set the workspace's file tabs carry, plus this strip's own rename and the pop-out toggle — which
// the empty-strip right-click below stops reaching once the tabs wrap and fill both rows. The menu acts on the
// RIGHT-CLICKED tab (`menuTabId`); the commands further down act on the ACTIVE one — the split the workspace makes.
const tabMenu = ref<{ show: (event: Event) => void } | undefined>();
const menuTabId = ref<string>();

const tabMenuItems = computed<MenuItem[]>(() => {
    const id = menuTabId.value;
    if (id === undefined || !conversations.value.some((c) => c.id === id)) {
        return [];
    }
    const others = othersOf(id);
    const toRight = toRightOf(id);
    const items: MenuItem[] = [
        { label: `Rename`, icon: `pencil`, shortcut: commandShortcut(`chat.rename`), command: () => beginRename(id) },
        { separator: true },
        { label: `Close`, icon: `times`, shortcut: commandShortcut(`chat.closeTab`), command: () => emit(`close`, new Set([id])) },
        {
            label: `Close Others`,
            disabled: others.size === 0,
            shortcut: commandShortcut(`chat.closeOtherTabs`),
            command: () => requestClose(others),
        },
        {
            label: `Close to the Right`,
            disabled: toRight.size === 0,
            shortcut: commandShortcut(`chat.closeTabsToRight`),
            command: () => requestClose(toRight),
        },
        { separator: true },
        { label: `Close All`, shortcut: commandShortcut(`chat.closeAllTabs`), command: () => requestClose(allTabs()) },
    ];
    if (popoutSupported) {
        items.push(
            { separator: true },
            {
                label: poppedOut.value ? `Dock chat back` : `Move chat into new window`,
                shortcut: commandShortcut(`chat.togglePopout`),
                command: togglePopout,
            },
        );
    }
    return items;
});

const openTabMenu = (id: string, event: Event): void => {
    // The pointer stays on the tab, so the hover card would never leave on its own — and it floats exactly where
    // the menu is about to open.
    hidePreview();
    menuTabId.value = id;
    tabMenu.value?.show(event);
};

// Registered while THIS strip is mounted — the desktop strip and the mobile one are exclusive, so the ids can't
// double-register. Rename is gated to a keystroke from inside the chat panel: elsewhere F2 belongs to whoever owns
// the focus (the workspace tree renames its file, the terminal panel its terminal).
//
// The four closes ship UNBOUND, unlike the workspace file tabs' Ctrl+Shift+{X , . Backspace} family. The chat
// panel is mounted beside the Workspace in the desktop shell, so those chords are already claimed there whenever
// /workspace is open, and a second claim on them would resolve by registration order rather than by focus. They
// stay palette-only (Ctrl+Shift+P) and rebindable in Settings → Keybindings — the menu reads whatever chord the
// registry ends up holding, so binding one lights its hint up here.
let commandDisposables: readonly Disposable[] = [];
onMounted(() => {
    const entries: Omit<RegisteredCommand, `owner`>[] = [
        {
            command: `chat.rename`,
            title: `Rename Chat…`,
            icon: `pencil`,
            keybinding: `F2`,
            when: (event): boolean => event.target instanceof Element && event.target.closest(`.chat-panel`) !== null,
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
            handler: () => emit(`close`, new Set([activeId.value])),
        },
        {
            command: `chat.closeOtherTabs`,
            title: `Close Other Chats`,
            icon: `times`,
            handler: (): void => {
                const others = othersOf(activeId.value);
                if (others.size > 0) {
                    requestClose(others);
                }
            },
        },
        {
            command: `chat.closeTabsToRight`,
            title: `Close Chats to the Right`,
            icon: `times`,
            handler: (): void => {
                const toRight = toRightOf(activeId.value);
                if (toRight.size > 0) {
                    requestClose(toRight);
                }
            },
        },
        { command: `chat.closeAllTabs`, title: `Close All Chats`, icon: `times`, handler: () => requestClose(allTabs()) },
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

// Right-click on the empty strip area pops the chat out / docks it (replaces the old pop-out button).
const onContextMenu = (event: MouseEvent): void => {
    if (!popoutSupported || event.target !== event.currentTarget) return; // only empty strip, not a tab
    event.preventDefault();
    togglePopout();
};

const openHistory = (event: Event): void => {
    query.value = ``;
    void loadSessions();
    history.value?.toggle(event);
};
</script>

<template>
    <header class="view-header view-header-wrap flex items-center gap-1 border-b border-line px-1.5">
        <!-- Tabs fill one row, then wrap to a second; only past two rows does the strip scroll vertically. It
             never scrolls sideways, so no tab hides off the right edge. One row still measures exactly a
             .view-header (a 26px tab row plus its py-1 is under the 2.25rem floor), so the shell-wide header
             line reads unbroken until there are genuinely more tabs than fit; from the second row on, this bar
             alone stands taller (.view-header-wrap, styles.css). max-h-16 is those two rows WITH the padding —
             the strip is the scroll box, so its own py counts against the cap. The ✚ and history buttons sit
             outside the strip, so they never move; their h-7 rides inside the floor with no header padding. -->
        <div
            ref="strip"
            class="scrollbar-thin flex max-h-16 min-w-0 flex-1 flex-wrap items-center gap-1 overflow-x-hidden overflow-y-auto py-1"
            @contextmenu="onContextMenu"
        >
            <template v-for="c in conversations" :key="c.id">
                <!-- Renaming REPLACES the tab rather than nesting a field inside it: an input in a button is
                     neither valid markup nor a usable caret. Enter commits, Esc cancels, blur commits, an empty
                     or unchanged name silently cancels — the WorkspaceTree convention, via createTitleEdit. -->
                <input
                    v-if="edit.editing && renamingId === c.id"
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
                    :data-chat-tab="c.id"
                    class="chat-tab group flex min-w-20 max-w-40 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs"
                    :class="{ 'chat-tab-on': activeId === c.id }"
                    @click="emit('select', c.id)"
                    @dblclick.prevent.stop="beginRename(c.id)"
                    @contextmenu.prevent.stop="openTabMenu(c.id, $event)"
                    @mouseenter="showPreview($event, c)"
                    @mouseleave="hidePreview"
                >
                    <!-- Came in from outside (a Discord mention, a visitor, a webhook) rather than from you. -->
                    <OriginMark :origin="originOf(c)" compact />
                    <!-- One noun with the fleet: an untitled isolated conversation IS a draft agent card there. -->
                    <span class="min-w-0 flex-1 truncate text-left" :class="statusTabClass(c.status.value)">{{ tabLabel(c) }}</span>
                    <!-- Members with this same conversation active right now. -->
                    <PresenceAvatars v-if="c.session.value !== undefined" :viewers="viewersOfSession(c.session.value.id)" label="in this chat" />
                    <Icon
                        name="times"
                        v-if="conversations.length > 1"
                        @click="closeTab($event, c.id)"
                        class="-mr-1 shrink-0 text-2xs opacity-0 transition-opacity hover:text-content group-hover:opacity-60"
                    />
                </button>
            </template>
        </div>
        <!-- A failed rename already reverted the title; this says why. Cleared by the next rename. -->
        <span v-if="edit.error !== undefined" class="min-w-0 shrink truncate text-2xs text-danger" v-tooltip.bottom="edit.error">{{
            edit.error
        }}</span>
        <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="startAgent" v-tooltip.bottom="'New agent'" aria-label="New agent">
            <Icon name="plus" class="text-sm" />
        </button>
        <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="openHistory" v-tooltip.bottom="'History'" aria-label="Chat history">
            <Icon name="history" class="text-sm" />
        </button>
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
                        title="Clear (Esc)"
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
                            <span class="text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
                        </button>
                    </template>
                    <p v-else class="px-2 py-3 text-center text-2xs text-subtle">{{ query ? "No matching chats." : "No previous chats." }}</p>
                </div>
            </div>
        </Popover>
    </header>
    <!-- Full first message on tab hover: a compact card, teleported out of the strip's clipping and clamped to
         the window. pointer-events-none so it never eats the hover that summons it. -->
    <Teleport :to="overlayTarget">
        <div
            v-if="preview"
            class="pointer-events-none fixed z-50 line-clamp-[12] max-w-[320px] min-w-[12rem] rounded-lg border border-line-strong bg-card px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap text-content shadow-2xl"
            :style="{
                left: `${preview.left}px`,
                ...(preview.top !== undefined ? { top: `${preview.top}px` } : {}),
                ...(preview.bottom !== undefined ? { bottom: `${preview.bottom}px` } : {}),
            }"
        >
            {{ preview.text }}
        </div>
    </Teleport>

    <!-- Right-click tab menu. Rendered into the pop-out window while the chat floats there (`append-to`), with the
         same dense pt and shortcut-hint row the workspace's file-tab menu uses — one tab menu, two strips. -->
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

    <!-- The confirm a mass close gets when it would abort agents that are still working — the chat's counterpart
         of the workspace's unsaved-edits dialog. -->
    <Dialog
        :visible="pendingClose !== undefined"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :append-to="overlayTarget"
        :style="{ width: '26rem' }"
        :header="pendingCloseRunning.length === 1 ? 'Stop the running agent?' : `Stop ${pendingCloseRunning.length} running agents?`"
        @update:visible="pendingClose = undefined"
    >
        <ul class="flex flex-col gap-1">
            <li v-for="c in pendingCloseRunning.slice(0, 5)" :key="c.id" class="flex min-w-0 items-center gap-2 text-sm">
                <Icon name="spinner" spin class="shrink-0 text-2xs text-link" />
                <span class="truncate text-content">{{ tabLabel(c) }}</span>
            </li>
            <li v-if="pendingCloseRunning.length > 5" class="text-xs text-subtle">…and {{ pendingCloseRunning.length - 5 }} more</li>
        </ul>
        <p class="mt-3 text-xs text-muted">Closing these chats stops the turns they're running. The conversations stay in History.</p>
        <template #footer>
            <Button label="Cancel" severity="secondary" :text="true" @click="pendingClose = undefined" />
            <Button label="Close anyway" severity="danger" autofocus @click="confirmClose">
                <template #icon><Icon name="times" /></template>
            </Button>
        </template>
    </Dialog>
</template>

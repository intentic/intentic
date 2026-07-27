<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import Popover from "primevue/popover";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { startAgent } from "../composables/agents/agentActions";
import { createTitleEdit } from "../composables/agents/titleEdit";
import { relativeTime, statusTabClass } from "../composables/chat/catalog";
import type { Conversation } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { registerCommand } from "../composables/commands/useCommands";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";

/* The tab strip + history menu. Reads the conversation list from the useChat singleton; the panel owns the
 * side effects of SWITCHING (scroll pinning), so select/close/open are emitted rather than applied. "New
 * agent" is not one of them: it means the same thing here as on the fleet board, so both call the one
 * startAgent action (agents/agentActions.ts) instead of each surface assembling its own half of it. */

const emit = defineEmits<{
    select: [id: string];
    close: [id: string];
    open: [id: string];
}>();

const { conversations, activeId, sessions, loadSessions } = useChat();
const { supported: popoutSupported, toggle: togglePopout, overlayTarget } = useChatPopout();

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

// Registered while THIS strip is mounted — the desktop strip and the mobile one are exclusive, so the id can't
// double-register. Gated to a keystroke from inside the chat panel: elsewhere F2 belongs to whoever owns the
// focus (the workspace tree renames its file, the terminal panel its terminal).
let renameCommand: Disposable | undefined;
onMounted(() => {
    renameCommand = registerCommand({
        owner: `builtin`,
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
    });
});
onBeforeUnmount(() => renameCommand?.dispose());

// Close a tab without selecting it (the × sits inside the tab button, so stop the bubble).
const closeTab = (event: Event, id: string): void => {
    event.stopPropagation();
    emit(`close`, id);
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

// Hover preview: a compact card that reveals a tab's FIRST message IN FULL, standing in for the terse title
// tooltip (which only ever repeats the 40-char header). It teleports to the overlay target (the pip body while
// popped out, else <body>) so it escapes the tab strip's overflow-auto clipping, and flips above/below the tab
// depending on the room in that window — the same floating-preview idiom as the image attachments.
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
</script>

<template>
    <header class="flex min-h-9 items-center gap-1 border-b border-line px-1.5 py-1">
        <!-- Tabs fill one row, then wrap to a second; only past two rows (max-h-14) does the strip scroll
             vertically. It never scrolls sideways, so no tab hides off the right edge. -->
        <div
            ref="strip"
            class="scrollbar-thin flex max-h-14 min-w-0 flex-1 flex-wrap items-center gap-1 overflow-x-hidden overflow-y-auto"
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
                    class="chat-tab group flex min-w-0 max-w-40 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs"
                    :class="{ 'chat-tab-on': activeId === c.id }"
                    @click="emit('select', c.id)"
                    @dblclick.prevent.stop="beginRename(c.id)"
                    @mouseenter="showPreview($event, c)"
                    @mouseleave="hidePreview"
                >
                    <!-- One noun with the fleet: an untitled isolated conversation IS a draft agent card there. -->
                    <span class="min-w-0 flex-1 truncate text-left" :class="statusTabClass(c.status.value)">{{
                        c.title.value ?? (c.isolated.value ? "New agent" : "New chat")
                    }}</span>
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
</template>

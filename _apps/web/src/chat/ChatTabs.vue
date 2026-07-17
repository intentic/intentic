<script setup lang="ts">
import Popover from "primevue/popover";
import { onBeforeUnmount, ref, watch } from "vue";
import { relativeTime, statusTabClass } from "../composables/chat/catalog";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";

/* The tab strip + history menu. Reads the conversation list from the useChat singleton; the panel owns the
 * side effects of switching (scroll pinning, composer focus), so tab actions are emitted rather than applied. */

const emit = defineEmits<{
    select: [id: string];
    close: [id: string];
    new: [];
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
</script>

<template>
    <header class="flex items-center gap-1 border-b border-line px-1.5 py-1">
        <div class="scrollbar-thin flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" @contextmenu="onContextMenu">
            <button
                v-for="c in conversations"
                :key="c.id"
                type="button"
                class="chat-tab group flex min-w-0 max-w-40 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs"
                :class="{ 'chat-tab-on': activeId === c.id }"
                @click="emit('select', c.id)"
                v-tooltip.bottom="c.title.value ?? (c.isolated.value ? 'New agent' : 'New chat')"
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
        </div>
        <button type="button" class="composer-ghost h-7 w-7 shrink-0" @click="emit('new')" v-tooltip.bottom="'New agent'" aria-label="New agent">
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
                                <span class="min-w-0 flex-1 truncate text-sm text-content">{{ session.title }}</span>
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
</template>

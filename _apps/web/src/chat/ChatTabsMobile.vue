<script setup lang="ts">
import { BottomSheet } from "@intentic-app/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { startAgent } from "../composables/agents/agentActions";
import { useAgents } from "../composables/agents/useAgents";
import { statusIcon } from "../composables/chat/catalog";
import { useChat } from "../composables/chat/useChat";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";
import PastChatList from "./PastChatList.vue";

/* The mobile counterpart of ChatTabs: a compact header naming the active conversation, with the open-tab
 * strip and the searchable history folded into one bottom sheet. Same emit contract as ChatTabs — the panel
 * owns the side effects of switching, and "New agent" runs the one shared startAgent action (which on this
 * form factor also routes to the new agent's screen, since there is no dock to reveal it). */

const emit = defineEmits<{
    select: [id: string];
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, sessions, loadSessions } = useChat();
const active = computed(() => conversations.value.find((c) => c.conversationId === activeId.value));

// Archiving closes an agent's chat (see the archive note in useAgents), but one opened from the archive is still
// off the board, so the sheet marks those — the panel's own line only speaks for whichever chat is open.
const { agentById } = useAgents();
const isArchived = (conversationId: string): boolean => agentById(conversationId)?.archivedAt !== undefined;

const sheetOpen = ref(false);

// The history search box. Filters the list by chat title or content (content scanned server-side over recent
// sessions). Debounced so a keystroke burst becomes one request; the list binds directly to `sessions`.
const query = ref(``);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadSessions(value.trim() || undefined), 200);
});
onBeforeUnmount(() => clearTimeout(searchTimer));

const openSheet = (): void => {
    query.value = ``;
    void loadSessions();
    sheetOpen.value = true;
};

const pick = (id: string): void => {
    sheetOpen.value = false;
    emit(`select`, id);
};

const openFromHistory = (id: string): void => {
    sheetOpen.value = false;
    emit(`open`, id);
};
</script>

<template>
    <header class="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <!-- The whole title area opens the conversation sheet — the biggest possible touch target. -->
        <button type="button" class="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left active:bg-overlay" @click="openSheet">
            <Icon v-if="active" v-bind="statusIcon(active.status.value)" />
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-content">{{
                active?.title.value ?? (active?.isolated.value ? "New agent" : "New chat")
            }}</span>
            <PresenceAvatars
                v-if="active && active.session.value !== undefined"
                :members="viewersOfSession(active.session.value.id)"
                label="in this chat"
            />
            <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
        </button>
        <button type="button" class="composer-ghost h-10 w-10 shrink-0" @click="startAgent()" aria-label="New agent">
            <Icon name="plus" class="text-base" />
        </button>

        <BottomSheet v-model="sheetOpen" header="Chats">
            <div class="flex flex-col gap-0.5">
                <button
                    v-for="c in conversations"
                    :key="c.conversationId"
                    type="button"
                    class="flex h-12 items-center gap-2.5 rounded-lg px-2 text-left transition-colors active:bg-overlay"
                    :class="{ 'bg-primary-600/15': activeId === c.conversationId }"
                    @click="pick(c.conversationId)"
                >
                    <Icon v-bind="statusIcon(c.status.value)" />
                    <span class="min-w-0 flex-1 truncate text-sm" :class="activeId === c.conversationId ? 'text-link' : 'text-content'">{{
                        c.title.value ?? (c.isolated.value ? "New agent" : "New chat")
                    }}</span>
                    <!-- Archived: off the agents board, but the conversation is still open right here. -->
                    <Icon v-if="isArchived(c.conversationId)" name="box" class="shrink-0 text-2xs text-subtle" />
                    <PresenceAvatars v-if="c.session.value !== undefined" :members="viewersOfSession(c.session.value.id)" label="in this chat" />
                    <!-- span, not button — a real button can't nest inside the row button. -->
                    <span
                        v-if="conversations.length > 1"
                        role="button"
                        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-subtle active:bg-content/10"
                        @click.stop="emit('close', new Set([c.conversationId]))"
                        aria-label="Close chat"
                    >
                        <Icon name="times" class="text-xs" />
                    </span>
                </button>

                <div class="relative mx-1 mb-1 mt-2">
                    <Icon
                        name="search"
                        aria-hidden="true"
                        class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                    />
                    <input
                        v-model="query"
                        type="search"
                        placeholder="Search chats…"
                        class="h-10 w-full min-w-0 rounded-lg border border-line bg-canvas pl-8 pr-3 text-base text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                    />
                </div>
                <PastChatList :sessions="sessions" :query="query" touch @open="openFromHistory" />
            </div>
        </BottomSheet>
    </header>
</template>

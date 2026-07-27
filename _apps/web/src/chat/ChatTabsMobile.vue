<script setup lang="ts">
import { BottomSheet } from "@intentic-app/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { startAgent } from "../composables/agents/agentActions";
import { relativeTime, statusIcon } from "../composables/chat/catalog";
import { useChat } from "../composables/chat/useChat";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";

/* The mobile counterpart of ChatTabs: a compact header naming the active conversation, with the open-tab
 * strip and the searchable history folded into one bottom sheet. Same emit contract as ChatTabs — the panel
 * owns the side effects of switching, and "New agent" runs the one shared startAgent action (which on this
 * form factor also routes to the new agent's screen, since there is no dock to reveal it). */

const emit = defineEmits<{
    select: [id: string];
    close: [id: string];
    open: [id: string];
}>();

const { conversations, activeId, sessions, loadSessions } = useChat();
const active = computed(() => conversations.value.find((c) => c.id === activeId.value));

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
                :viewers="viewersOfSession(active.session.value.id)"
                label="in this chat"
            />
            <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
        </button>
        <button type="button" class="composer-ghost h-10 w-10 shrink-0" @click="startAgent" aria-label="New agent">
            <Icon name="plus" class="text-base" />
        </button>

        <BottomSheet v-model="sheetOpen" header="Chats">
            <div class="flex flex-col gap-0.5">
                <button
                    v-for="c in conversations"
                    :key="c.id"
                    type="button"
                    class="flex h-12 items-center gap-2.5 rounded-lg px-2 text-left transition-colors active:bg-overlay"
                    :class="{ 'bg-primary-600/15': activeId === c.id }"
                    @click="pick(c.id)"
                >
                    <Icon v-bind="statusIcon(c.status.value)" />
                    <span class="min-w-0 flex-1 truncate text-sm" :class="activeId === c.id ? 'text-link' : 'text-content'">{{
                        c.title.value ?? (c.isolated.value ? "New agent" : "New chat")
                    }}</span>
                    <PresenceAvatars v-if="c.session.value !== undefined" :viewers="viewersOfSession(c.session.value.id)" label="in this chat" />
                    <!-- span, not button — a real button can't nest inside the row button. -->
                    <span
                        v-if="conversations.length > 1"
                        role="button"
                        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-subtle active:bg-content/10"
                        @click.stop="emit('close', c.id)"
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
                <template v-if="sessions.length > 0">
                    <button
                        v-for="session in sessions"
                        :key="session.id"
                        type="button"
                        class="flex min-h-12 flex-col justify-center gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors active:bg-overlay"
                        @click="openFromHistory(session.id)"
                    >
                        <span class="flex items-center gap-1.5">
                            <span class="min-w-0 flex-1 truncate text-sm text-content">{{ session.title }}</span>
                            <PresenceAvatars :viewers="viewersOfSession(session.id)" label="in this chat" />
                        </span>
                        <span class="text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
                    </button>
                </template>
                <p v-else class="px-2 py-3 text-center text-2xs text-subtle">{{ query ? "No matching chats." : "No previous chats." }}</p>
            </div>
        </BottomSheet>
    </header>
</template>

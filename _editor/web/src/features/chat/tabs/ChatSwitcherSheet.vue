<script setup lang="ts">
import { BottomSheet, SearchBar } from "@intentic/ui";
import { onBeforeUnmount, ref, watch } from "vue";
import { useAgents } from "../../agents/fleet/useAgents";
import { statusIcon } from "../models/catalog";
import { useChat } from "../run/useChat";
import { viewersOfSession } from "../../../shell/presence/usePresence";
import PresenceAvatars from "../../../shell/presence/PresenceAvatars.vue";
import PastChatList from "../panel/PastChatList.vue";
import { useT } from "@intentic/ui/i18n";

// The phone's chat switcher: the open chats, a new one, and the stored sessions behind a search box. One sheet with
// two hosts (ChatTabsMobile's header, the agent screen's title), so where a past chat can be reached from cannot
// drift between them. Picking closes the sheet; what the pick does is the host's.

const t = useT();

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ select: [id: string]; close: [ids: ReadonlySet<string>]; open: [id: string]; new: [] }>();

const { conversations, activeId, sessions, loadSessions } = useChat();

// Archiving closes an agent's chat (see the archive note in useAgents), but one opened from the archive is still
// off the board, so the sheet marks those: the host's own line only speaks for whichever chat is open.
const { agentById } = useAgents();
const isArchived = (conversationId: string): boolean => agentById(conversationId)?.archivedAt !== undefined;

// The history search box. Filters the list by chat title or content (content scanned server-side over recent
// sessions). Debounced so a keystroke burst becomes one request; the list binds directly to `sessions`.
const query = ref(``);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadSessions(value.trim() || undefined), 200);
});
onBeforeUnmount(() => clearTimeout(searchTimer));

// Opening starts clean and re-reads the stored sessions, so the list is current as of the tap.
watch(open, (showing) => {
    if (showing) {
        query.value = ``;
        void loadSessions();
    }
});

const pick = (id: string): void => {
    open.value = false;
    emit(`select`, id);
};

const openFromHistory = (id: string): void => {
    open.value = false;
    emit(`open`, id);
};

const startNew = (): void => {
    open.value = false;
    emit(`new`);
};
</script>

<template>
    <BottomSheet v-model="open" :header="t(`chat.chatSwitcherSheet.chats`)">
        <div class="flex flex-col gap-0.5">
            <!-- First, where a thumb lands: the one press that isn't a choice among what's already open. -->
            <button
                type="button"
                class="flex h-12 items-center gap-2.5 rounded-lg px-2 text-left text-sm text-link active:bg-overlay"
                @click="startNew"
            >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center"><Icon name="plus" class="text-base" /></span>
                {{ t(`shared.newAgent`) }}
            </button>
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
                    c.title.value ?? (c.isolated.value ? t(`shared.newAgent`) : t(`shared.newChat`))
                }}</span>
                <!-- Archived: off the agents board, but the conversation is still open right here. -->
                <Icon v-if="isArchived(c.conversationId)" name="box" class="shrink-0 text-2xs text-subtle" />
                <PresenceAvatars v-if="c.session.value !== undefined" :members="viewersOfSession(c.session.value.id)" :label="t(`shared.inChat`)" />
                <!-- span, not button: a real button can't nest inside the row button. -->
                <span
                    v-if="conversations.length > 1"
                    role="button"
                    class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-subtle active:bg-content/10"
                    @click.stop="emit('close', new Set([c.conversationId]))"
                    :aria-label="t(`shared.closeChat`)"
                >
                    <Icon name="times" class="text-xs" />
                </span>
            </button>

            <SearchBar
                v-model="query"
                variant="field"
                clearable
                :aria-label="t(`shared.searchChats`)"
                :placeholder="t(`shared.searchChats2`)"
                class="mx-1 mb-1 mt-2"
            />
            <PastChatList :sessions="sessions" :query="query" touch @open="openFromHistory" />
        </div>
    </BottomSheet>
</template>

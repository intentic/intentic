<script setup lang="ts">
import { computed, ref } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { statusIcon } from "../models/catalog";
import { useChat } from "../run/useChat";
import { viewersOfSession } from "../../../shell/presence/usePresence";
import PresenceAvatars from "../../../shell/presence/PresenceAvatars.vue";
import ChatSwitcherSheet from "./ChatSwitcherSheet.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The mobile counterpart of ChatTabs: a compact header naming the active conversation, over the shared switcher sheet. */

const emit = defineEmits<{
    select: [id: string];
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId } = useChat();
const active = computed(() => conversations.value.find((c) => c.conversationId === activeId.value));

const sheetOpen = ref(false);
</script>

<template>
    <header class="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <!-- The whole title area opens the conversation sheet: the biggest possible touch target. -->
        <button
            type="button"
            class="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left active:bg-overlay"
            @click="sheetOpen = true"
        >
            <Icon v-if="active" v-bind="statusIcon(active.status.value)" />
            <!-- Italic while this chat is only being looked at (Conversation.peek): the phone's tap on a fleet card is a look like the desktop's click. -->
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-content" :class="{ italic: active?.peek.value }">{{
                active?.title.value ?? (active?.isolated.value ? t(`chat.words.newAgent`) : t(`chat.words.newChat`))
            }}</span>
            <PresenceAvatars
                v-if="active && active.session.value !== undefined"
                :members="viewersOfSession(active.session.value.id)"
                :label="t(`chat.words.inChat`)"
            />
            <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
        </button>
        <button type="button" class="composer-ghost h-10 w-10 shrink-0" @click="startAgent()" :aria-label="t(`chat.words.newAgent`)">
            <Icon name="plus" class="text-base" />
        </button>

        <ChatSwitcherSheet
            v-model="sheetOpen"
            @select="emit('select', $event)"
            @close="emit('close', $event)"
            @open="emit('open', $event)"
            @new="startAgent()"
        />
    </header>
</template>

<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useAgents } from "../../../agents/fleet/useAgents";
import { usePaneView } from "../../panel/useChat-view";
import type { ChatMessage } from "../transcript";

/* Disarms the one watch this row names, leaving the conversation's others armed; a fired watch's row keeps no button. */

const props = defineProps<{ message: ChatMessage }>();

const t = useT();
const { conversation } = usePaneView();
const { agentById, stopWatching } = useAgents();
const armed = computed(
    () => agentById(conversation.value.conversationId)?.watches?.some((watch) => watch.id === props.message.noticeWaitId) === true,
);

const stop = async (): Promise<void> => {
    await stopWatching(conversation.value.conversationId, props.message.noticeWaitId).catch(() => undefined);
};
</script>

<template>
    <template v-if="armed">
        <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="stop">
            {{ t(`shared.stopWatching`) }}
        </button>
        <span class="shrink-0">{{ t(`chat.chatMessageView.chatStaysPutInstead`) }}</span>
    </template>
</template>

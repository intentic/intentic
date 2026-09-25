<script setup lang="ts">
import { errorMessage } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
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

// Why the last press didn't take: the button comes back, and a watch left armed keeps waking the agent.
const refused = ref<string | undefined>(undefined);
const stop = async (): Promise<void> => {
    refused.value = undefined;
    await stopWatching(conversation.value.conversationId, props.message.noticeWaitId).catch((error: unknown) => {
        refused.value = errorMessage(error, `The watch could not be stopped.`);
    });
};
</script>

<template>
    <template v-if="armed">
        <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="stop">
            {{ t(`agents.words.stopWatching`) }}
        </button>
        <span v-if="refused !== undefined" role="alert" class="shrink-0 text-danger">{{ refused }}</span>
        <span v-else class="shrink-0">{{ t(`chat.chatMessageView.chatStaysPutInstead`) }}</span>
    </template>
</template>

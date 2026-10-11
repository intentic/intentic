<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useAgents } from "../../../agents/fleet/useAgents";
import { usePaneView } from "../../panel/useChat-view";
import { useOperation } from "../../../../workbench/operations/operations";
import type { ChatMessage } from "../transcript";

/* Disarms the one watch this row names, leaving the conversation's others armed; a fired watch's row keeps no button. */

const props = defineProps<{ message: ChatMessage }>();

const t = useT();
const { conversation } = usePaneView();
const { agentById, stopWatching } = useAgents();
const watch = computed(() => agentById(conversation.value.conversationId)?.watches?.find((armed) => armed.id === props.message.noticeWaitId));
const armed = computed(() => watch.value !== undefined);

// The same stop the card of what is left running presses (ChatLeftRunning), filed under the same key, so a press on
// either holds both and a row scrolled away and drawn again still knows. Why the last press didn't take is said too: the
// button comes back, and a watch left armed keeps waking the agent.
const stopping = useOperation(() => `chat/${conversation.value.conversationId}/stops/watch:${props.message.noticeWaitId ?? ``}`);
const busy = stopping.busy;
const refused = computed(() => stopping.failure.value && (stopping.failure.value.detail ?? stopping.failure.value.title));
const stop = async (): Promise<void> => {
    const id = conversation.value.conversationId;
    const watchId = props.message.noticeWaitId;
    const label = watch.value?.note ?? props.message.text;
    await stopping.run({
        what: t(`chat.chatLeftRunning.stoppingRow`, { label }),
        failed: t(`chat.noticeWatchStop.couldNotStop`),
        done: () => t(`chat.chatLeftRunning.stoppedRow`, { label }),
        task: () => stopWatching(id, watchId),
    });
};
</script>

<template>
    <template v-if="armed">
        <button type="button" class="touch-target shrink-0 font-medium text-link hover:underline" :disabled="busy" @click="stop">
            {{ t(`agents.words.stopWatching`) }}
        </button>
        <span v-if="refused !== undefined" role="alert" class="shrink-0 text-danger">{{ refused }}</span>
        <span v-else class="shrink-0">{{ t(`chat.chatMessageView.chatStaysPutInstead`) }}</span>
    </template>
</template>

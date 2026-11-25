<script setup lang="ts">
import { Button, type ButtonTier } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useAgents } from "../../../../models/fleet/useAgents";
import { stoppedOrSay } from "../../panel/jobs/stopOutcome";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { useOperation } from "../../../../workbench/operations/operations";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";

/* Disarms the one watch this row names, leaving the conversation's others armed; a fired watch's row keeps no button. */

const props = withDefaults(defineProps<{ message: ChatMessage; tier?: ButtonTier }>(), { tier: `quiet` });

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
        task: async () => stoppedOrSay(await stopWatching(id, watchId), (reason) => t(`chat.chatLeftRunning.nothingStopped`, { reason })),
    });
};
</script>

<template>
    <template v-if="armed">
        <Button
            size="small"
            :tier="props.tier"
            class="shrink-0"
            :disabled="busy"
            v-tooltip.top="{ title: t(`agents.words.stopWatching`), note: t(`chat.noticeWatchStop.staysPut`) }"
            @click="stop"
        >
            {{ t(`agents.words.stopWatching`) }}
        </Button>
        <span v-if="refused !== undefined" role="alert" class="shrink-0 text-danger">{{ refused }}</span>
    </template>
</template>

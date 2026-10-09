<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import TurnBreakQuestion from "../../panel/TurnBreakQuestion.vue";
import { usePaneView } from "../../panel/useChat-view";
import { memoryNext } from "../../run/turnBreak";
import type { ChatMessage } from "../transcript";
import ChatHeldStatus from "../held/ChatHeldStatus.vue";
import { memoryReading, useHeldQueue, useKeptTurn } from "../held/heldQueue";
import { memoryTip, sendAnywayTip } from "../held/memoryTip";
import MemoryRaise from "./MemoryRaise.vue";

/* The row a low-memory hold leaves, drawn as one line whatever it says: the sandbox's figures are a hover card away. */

const props = defineProps<{ message: ChatMessage }>();

const t = useT();
const { conversation } = usePaneView();
const { notice } = useHeldQueue();
const { waiting, send } = useKeptTurn(() => props.message);

// The held message's own line says this row while its words wait in the queue (ChatHeldMessages); the transcript
// leaves it out then (ChatPaneTurns), and this is only the guard for a host that does not.
const folded = computed(() => notice.value?.id === props.message.id);
// The words are the sandbox's to keep for a turn it started itself, and the message they belong to is the row above.
const heldHere = computed(() => !folded.value && waiting.value);
const figures = computed(() => memoryTip(memoryReading(props.message.text)));
</script>

<template>
    <!-- Under the kept message, the same line a queued one gets: it was not sent, why, the press, and what happens next. -->
    <div v-if="heldHere" class="flex flex-col items-end gap-1 self-end">
        <ChatHeldStatus reason="memory" :detail="memoryReading(message.text)">
            <Button size="small" v-tooltip.top="sendAnywayTip()" @click="send">{{ t(`chat.chatHeld.sendAnyway`) }}</Button>
            <MemoryRaise v-if="message.noticeAction === `sandboxMemory`" />
        </ChatHeldStatus>
        <div class="flex flex-col items-end gap-1 text-2xs text-muted">
            <TurnBreakQuestion ending="memory" :conversation-id="conversation.conversationId" :describe="memoryNext" end />
        </div>
    </div>
    <!-- Settled: what happened, in the past tense, since the press it offered is gone with the hold. -->
    <div v-else-if="!folded" class="flex items-center gap-x-2 self-center py-0.5 text-2xs text-subtle" v-tooltip.top="figures">
        <Icon name="info-circle" class="shrink-0 text-xs" />
        <span class="min-w-0">{{ message.sandboxHeld === true ? t(`chat.chatHeld.turnWasHeld`) : t(`chat.chatHeld.wasHeld`) }}</span>
    </div>
</template>

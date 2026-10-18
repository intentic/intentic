<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import TurnBreakQuestion from "../../panel/TurnBreakQuestion.vue";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { memoryNext } from "../../../../models/conversations/endings/turnBreak";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import ChatHeldStatus from "../held/ChatHeldStatus.vue";
import { memoryReading, useHeldQueue, useKeptTurn } from "../held/heldQueue";
import { memoryTip, sendAnywayTip } from "../../../../models/conversations/transcript/memoryTip";
import MemoryRaise from "./MemoryRaise.vue";
import { useReopenPress } from "../held/heldPresses";

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
// On an account spent until a reopen still ahead, the kept turn is booked to run again then (a Continue booked for later),
// and Send anyway steps back to a quiet press, as on every held message (heldPresses.ts).
const reopen = useReopenPress(() => heldHere.value);
const atReopen = computed(() => reopen.bookContinue.value);
</script>

<template>
    <!-- Under the kept message, the same line a queued one gets: it was not sent, why, the press, and what happens next. -->
    <div v-if="heldHere" class="flex flex-col items-end gap-1 self-end">
        <ChatHeldStatus reason="memory" :detail="memoryReading(message.text)">
            <Button v-if="atReopen !== undefined" size="small" thumb v-tooltip.top="reopen.hint.value" @click="atReopen()">
                <Icon name="clock" class="mr-1 text-2xs" />{{ reopen.label.value }}
            </Button>
            <Button size="small" thumb :tier="atReopen === undefined ? undefined : `quiet`" v-tooltip.top="sendAnywayTip()" @click="send">{{
                t(`chat.chatHeld.sendAnyway`)
            }}</Button>
            <MemoryRaise v-if="message.noticeAction === `sandboxMemory`" />
        </ChatHeldStatus>
        <div class="flex flex-col items-end gap-1 text-2xs text-muted">
            <TurnBreakQuestion ending="memory" :conversation-id="conversation.conversationId" :describe="memoryNext" end />
        </div>
    </div>
    <!-- Settled: what happened, in the past tense, since the press it offered is gone with the hold. -->
    <div v-else-if="!folded" class="chat-meta flex w-full items-start gap-x-2 py-0.5 text-2xs text-subtle" v-tooltip.top="figures">
        <span class="chat-mark"><Icon name="info-circle" class="text-xs" /></span>
        <span class="min-w-0">{{ message.sandboxHeld === true ? t(`chat.chatHeld.turnWasHeld`) : t(`chat.chatHeld.wasHeld`) }}</span>
    </div>
</template>

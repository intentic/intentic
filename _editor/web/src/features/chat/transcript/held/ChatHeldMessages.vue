<script setup lang="ts">
import { Button, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { usePaneView } from "../../panel/useChat-view";
import MemoryRaise from "../notices/MemoryRaise.vue";
import ChatHeldBubble from "./ChatHeldBubble.vue";
import ChatHeldStatus from "./ChatHeldStatus.vue";
import { useHeldQueue } from "./heldQueue";
import { sendAnywayTip } from "./memoryTip";

/* What the conversation's queue holds, drawn where the reader looks for a message they just sent: at the foot of the transcript, as their own prompts, each marked not sent, over the one line that says why and the one press that sends them. */

defineProps<{
    // The quick bar's composer, with no transcript above it: each message on one line (ChatHeldBubble).
    compact?: boolean;
}>();

const t = useT();
const { queued, streaming, resumeQueue } = usePaneView();
const { held, notice, reason, detail, until } = useHeldQueue();

// The one press, worded for what it overrides: a warning it goes past, a refusal it tries again, a stop it undoes. All
// three let the queue go (TurnClient.resume): a low-memory hold warns a person once a spell, so the next try runs.
// Only the warning's press has a hover: the risk it runs. The other two say all there is on their face.
interface HeldPress {
    readonly label: string;
    readonly hint?: Tip;
}
const press = computed((): HeldPress => {
    switch (reason.value) {
        case `memory`:
            return { label: t(`chat.chatHeld.sendAnyway`), hint: sendAnywayTip() };
        case `stopped`:
            return { label: t(`chat.chatQueue.sendNow`) };
        // Sooner than booked: the allowance it waits on may still be spent, which is the one thing worth a hover.
        case `scheduled`:
            return { label: t(`chat.chatQueue.sendNow`), hint: { title: t(`chat.chatHeld.sendNowTitle`), note: t(`chat.chatHeld.sendNowSpent`) } };
        default:
            return { label: t(`agents.words.sendAgain`) };
    }
});
</script>

<template>
    <!-- Over a composer (the quick bar) it is a card of its own, since whatever page it floats on shows through a bare row. -->
    <div
        v-if="held"
        class="flex flex-col gap-2"
        :class="compact ? `rounded-xl border border-line-strong bg-card px-3 py-2` : `items-end pt-1`"
    >
        <ChatHeldBubble v-for="message in queued" :key="message.id" :message="message" :compact="compact" />
        <ChatHeldStatus :reason="reason" :detail="detail" :until="until" :spread="compact">
            <!-- Held means nothing goes by itself (a scheduled send only at its time), even after a turn running now: the press lets it go, after that turn if one runs. -->
            <span class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                <Button size="small" v-tooltip.top="press.hint" @click="resumeQueue()">{{ press.label }}</Button>
                <!-- Only a hold that named its ceiling can be raised past (a stall names none), and never under a live turn, which the restart would kill. -->
                <MemoryRaise v-if="notice?.noticeAction === `sandboxMemory` && !streaming" />
            </span>
        </ChatHeldStatus>
    </div>
</template>

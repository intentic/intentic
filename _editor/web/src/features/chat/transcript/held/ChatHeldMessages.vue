<script setup lang="ts">
import { Button, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { usePaneView } from "../../panel/useChat-view";
import MemoryRaise from "../notices/MemoryRaise.vue";
import ChatHeldBooking from "./ChatHeldBooking.vue";
import ChatHeldBubble from "./ChatHeldBubble.vue";
import ChatHeldStatus from "./ChatHeldStatus.vue";
import { useHeldQueue } from "./heldQueue";
import { sendAnywayTip } from "./memoryTip";

/* What the conversation's queue holds, drawn where the reader looks for a message they just sent: at the foot of the transcript, as their own prompts. What a Stop or a refusal held is marked not sent, over the one line that says why and the one press that sends it. Each group of messages booked for later stands under its own line with the time it goes, its own Change and its own Send now (ChatHeldBooking). */

defineProps<{
    // The quick bar's composer, with no transcript above it: each message on one line (ChatHeldBubble).
    compact?: boolean;
}>();

const t = useT();
const { waiting, streaming, resumeQueue, bookedGroups } = usePaneView();
const { held, notice, reason, detail } = useHeldQueue();

// The one press, worded for what it overrides: a warning it goes past, a refusal it tries again, a stop it undoes. All
// three let the hold go (TurnClient.resume), and none touches a booked message: a low-memory hold warns a person once a
// spell, so the next try runs. Only the warning's press has a hover: the risk it runs.
interface HeldPress {
    readonly label: string;
    readonly hint?: Tip;
}
// What the press lets go: the messages the hold kept, by id, so a booking beside them stays on its time. Sent only to a
// sandbox that books each message (TurnClient.resume); an older one lets its whole queue go, as it always did.
const heldIds = computed(() => waiting.value.map((message) => message.id));
const press = computed((): HeldPress => {
    switch (reason.value) {
        case `memory`:
            return { label: t(`chat.chatHeld.sendAnyway`), hint: sendAnywayTip() };
        case `stopped`:
            return { label: t(`chat.chatQueue.sendNow`) };
        default:
            return { label: t(`agents.words.sendAgain`) };
    }
});
</script>

<template>
    <!-- Over a composer (the quick bar) it is a card of its own, since whatever page it floats on shows through a bare row. -->
    <div
        v-if="held || bookedGroups.length > 0"
        class="flex flex-col gap-2"
        :class="compact ? `rounded-xl bg-card shadow-sm px-3 py-2` : `items-end pt-1`"
    >
        <template v-if="held">
            <ChatHeldBubble v-for="message in waiting" :key="message.id" :message="message" :compact="compact" />
            <ChatHeldStatus :reason="reason" :detail="detail" :spread="compact">
                <!-- Held means nothing goes by itself, even after a turn running now: the press lets it go, after that turn if one runs. -->
                <span class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                    <Button size="small" v-tooltip.top="press.hint" @click="resumeQueue(heldIds)">{{ press.label }}</Button>
                    <!-- Only a hold that named its ceiling can be raised past (a stall names none), and never under a live turn, which the restart would kill. -->
                    <MemoryRaise v-if="notice?.noticeAction === `sandboxMemory` && !streaming" />
                </span>
            </ChatHeldStatus>
        </template>
        <ChatHeldBooking v-for="group in bookedGroups" :key="group.ids.join(` `)" :group="group" :compact="compact" />
    </div>
</template>

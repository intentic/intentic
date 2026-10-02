<script setup lang="ts">
import { Button, ResponsiveOverlay, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { agentDisplayTitle } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { openById } from "../../../agents/fleet/useAgents-actions";
import { supportsRoute } from "../../../sandbox/overview/useDaemonRoutes";
import ComposerSendLater from "../../composer/later/ComposerSendLater.vue";
import { bookingOf, laterOfQueue, type SendLater } from "../../composer/later/sendLater";
import { usePaneView } from "../../panel/useChat-view";
import MemoryRaise from "../notices/MemoryRaise.vue";
import ChatHeldBubble from "./ChatHeldBubble.vue";
import ChatHeldStatus from "./ChatHeldStatus.vue";
import { useHeldQueue } from "./heldQueue";
import { sendAnywayTip } from "./memoryTip";

/* What the conversation's queue holds, drawn where the reader looks for a message they just sent: at the foot of the transcript, as their own prompts, each marked not sent, over the one line that says why and the one press that sends them. A scheduled message also offers Change, which re-times it in the same panel that booked it. */

defineProps<{
    // The quick bar's composer, with no transcript above it: each message on one line (ChatHeldBubble).
    compact?: boolean;
}>();

const t = useT();
const { conversation, queued, streaming, resumeQueue, spentReopensAt } = usePaneView();
const { held, notice, reason, detail, until, after } = useHeldQueue();
const { agentById } = useAgents();

// The agent a scheduled message waits on, by its card's name, and the way to it; undefined title for one no card names.
const awaited = computed(() => {
    const id = after.value;
    if (id === undefined) {
        return undefined;
    }
    const agent = agentById(id);
    return { title: agent === undefined ? undefined : agentDisplayTitle(agent), open: (): void => openById(id) };
});

// The one press, worded for what it overrides: a warning it goes past, a refusal it tries again, a stop it undoes. All
// three let the queue go (TurnClient.resume): a low-memory hold warns a person once a spell, so the next try runs.
// Only the warning's press has a hover: the risk it runs, and for a scheduled one what it no longer waits for.
interface HeldPress {
    readonly label: string;
    readonly hint?: Tip;
}
// Sooner than booked: for a spent allowance, that it may still be spent; for another agent's work, that it goes without
// it; for a time the reader chose, only that it goes now.
const scheduledHint = (): Tip => {
    if (after.value !== undefined) {
        return { title: t(`chat.chatHeld.sendNowTitle`), note: t(`chat.chatHeld.sendNowAfterNote`) };
    }
    return { title: t(`chat.chatHeld.sendNowTitle`), note: spentReopensAt.value === undefined ? t(`chat.chatHeld.sendNowTimeNote`) : t(`chat.chatHeld.sendNowSpent`) };
};
const press = computed((): HeldPress => {
    switch (reason.value) {
        case `memory`:
            return { label: t(`chat.chatHeld.sendAnyway`), hint: sendAnywayTip() };
        case `stopped`:
            return { label: t(`chat.chatQueue.sendNow`) };
        case `scheduled`:
            return { label: t(`chat.chatQueue.sendNow`), hint: scheduledHint() };
        default:
            return { label: t(`agents.words.sendAgain`) };
    }
});

// Re-timing what waits: the panel that booked it, opened over its own press. Offered by a sandbox that can re-time.
const changeAnchor = ref<HTMLElement>();
const changing = ref(false);
const retimable = computed(() => reason.value === `scheduled` && supportsRoute(`agent.queueSchedule`));
const booked = computed(() => laterOfQueue(conversation.value.queue.value));
const retime = (later: SendLater): void => {
    changing.value = false;
    void conversation.value.turn.reschedule(bookingOf(later));
};
const sendNow = (): void => {
    changing.value = false;
    void resumeQueue();
};
</script>

<template>
    <!-- Over a composer (the quick bar) it is a card of its own, since whatever page it floats on shows through a bare row. -->
    <div
        v-if="held"
        class="flex flex-col gap-2"
        :class="compact ? `rounded-xl bg-card shadow-sm px-3 py-2` : `items-end pt-1`"
    >
        <ChatHeldBubble v-for="message in queued" :key="message.id" :message="message" :compact="compact" />
        <ChatHeldStatus :reason="reason" :detail="detail" :until="until" :after="awaited" :spread="compact">
            <!-- Held means nothing goes by itself (a scheduled send only at its time), even after a turn running now: the press lets it go, after that turn if one runs. -->
            <span class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                <span v-if="retimable" ref="changeAnchor" class="inline-flex">
                    <Button size="small" severity="secondary" :text="true" :aria-expanded="changing" @click="changing = !changing">{{
                        t(`chat.chatHeld.change`)
                    }}</Button>
                </span>
                <Button size="small" v-tooltip.top="press.hint" @click="resumeQueue()">{{ press.label }}</Button>
                <!-- Only a hold that named its ceiling can be raised past (a stall names none), and never under a live turn, which the restart would kill. -->
                <MemoryRaise v-if="notice?.noticeAction === `sandboxMemory` && !streaming" />
            </span>
        </ChatHeldStatus>
        <ResponsiveOverlay v-model="changing" :anchor="changeAnchor" cross="end" :header="t(`chat.sendLater.reschedule`)" panel-class="w-80 p-1">
            <ComposerSendLater
                :conversation="conversation"
                :picked="booked"
                :clear-label="t(`chat.chatQueue.sendNow`)"
                @pick="retime($event)"
                @clear="sendNow()"
            />
        </ResponsiveOverlay>
    </div>
</template>

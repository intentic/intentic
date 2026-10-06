<script setup lang="ts">
import { Button, ResponsiveOverlay, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { agentDisplayTitle } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { openById } from "../../../agents/fleet/useAgents-actions";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import ComposerSendLater from "../../composer/later/ComposerSendLater.vue";
import type { BookedGroup } from "../../composer/later/bookings";
import { bookingOf, type SendLater } from "../../composer/later/sendLater";
import { usePaneView } from "../../panel/useChat-view";
import ChatHeldBubble from "./ChatHeldBubble.vue";
import ChatHeldStatus from "./ChatHeldStatus.vue";

/* Messages booked for later that go together, drawn where the reader looks for what they sent: their own prompts, over one line with the time they go (or the agent they wait for), Change, which re-times them in the panel that booked them, and Send now. Both act on these messages alone: every other booking keeps its own time. */

const props = defineProps<{
    group: BookedGroup;
    // The quick bar's composer: each message on one line (ChatHeldBubble), the line spread across its card.
    compact?: boolean;
}>();

const t = useT();
const { conversation, resumeQueue, spentReopensAt } = usePaneView();
const { agentById } = useAgents();

const until = computed(() => (props.group.booking.kind === `at` ? props.group.booking.at : undefined));
const after = computed(() => (props.group.booking.kind === `after` ? props.group.booking.conversationId : undefined));

// The agent these wait on, by its card's name, and the way to it; undefined title for one no card names.
const awaited = computed(() => {
    const id = after.value;
    if (id === undefined) {
        return undefined;
    }
    const agent = agentById(id);
    return { title: agent === undefined ? undefined : agentDisplayTitle(agent), open: (): void => openById(id) };
});

// Sooner than booked: for a spent allowance, that it may still be spent; for another agent's work, that it goes without
// it; for a time the reader chose, only that it goes now.
const hint = computed((): Tip => {
    if (after.value !== undefined) {
        return { title: t(`chat.chatHeld.sendNowTitle`), note: t(`chat.chatHeld.sendNowAfterNote`) };
    }
    return { title: t(`chat.chatHeld.sendNowTitle`), note: spentReopensAt.value === undefined ? t(`chat.chatHeld.sendNowTimeNote`) : t(`chat.chatHeld.sendNowSpent`) };
});

// Re-timing these: the panel that booked them, opened over its own press. Offered by a sandbox that can re-time.
const changeAnchor = ref<HTMLElement>();
const changing = ref(false);
const retimable = computed(() => supportsRoute(`agent.queueSchedule`));
const retime = (later: SendLater): void => {
    changing.value = false;
    void conversation.value.turn.reschedule(bookingOf(later), props.group.ids);
};
const sendNow = (): void => {
    changing.value = false;
    void resumeQueue(props.group.ids);
};
</script>

<template>
    <ChatHeldBubble v-for="message in group.messages" :key="message.id" :message="message" :compact="compact" />
    <ChatHeldStatus reason="scheduled" :until="until" :after="awaited" :spread="compact">
        <span class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <span v-if="retimable" ref="changeAnchor" class="inline-flex">
                <Button size="small" severity="secondary" :text="true" :aria-expanded="changing" @click="changing = !changing">{{ t(`chat.chatHeld.change`) }}</Button>
            </span>
            <Button size="small" v-tooltip.top="hint" @click="sendNow()">{{ t(`chat.chatQueue.sendNow`) }}</Button>
        </span>
    </ChatHeldStatus>
    <ResponsiveOverlay v-model="changing" :anchor="changeAnchor" cross="end" :header="t(`chat.sendLater.reschedule`)" panel-class="w-80 p-1">
        <ComposerSendLater
            :conversation="conversation"
            :picked="group.booking"
            :clear-label="t(`chat.chatQueue.sendNow`)"
            @pick="retime($event)"
            @clear="sendNow()"
        />
    </ResponsiveOverlay>
</template>

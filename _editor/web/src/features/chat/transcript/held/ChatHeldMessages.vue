<script setup lang="ts">
import { Button, Icon, type Tip } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { useLimitResend } from "../../panel/pane/scheduledSend";
import { atReopenPhrase, pickUpWhen } from "../../../../models/conversations/endings/pickUp";
import TurnBreakQuestion from "../../panel/TurnBreakQuestion.vue";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { memoryNext } from "../../../../models/conversations/endings/turnBreak";
import MemoryRaise from "../notices/MemoryRaise.vue";
import ChatHeldBooking from "./ChatHeldBooking.vue";
import ChatHeldBubble from "./ChatHeldBubble.vue";
import ChatHeldStatus from "./ChatHeldStatus.vue";
import { HELD_PRESS_ATTR } from "../../panel/pane/heldLineSeen";
import { useHeldQueue } from "./heldQueue";
import { sendAnywayTip } from "../../../../models/conversations/transcript/memoryTip";
import { track } from "../../../../app/analytics";

/* What the conversation's queue holds, drawn where the reader looks for a message they just sent: at the foot of the transcript, as their own prompts. What a Stop or a refusal held is marked not sent, over the one line that says why and the one press that sends it; a low-memory hold also asks what happens next, as a spent allowance does. Each group of messages booked for later stands under its own line with the time it goes, its own Change and its own Send now (ChatHeldBooking). */

defineProps<{
    // The quick bar's composer, with no transcript above it: each message on one line (ChatHeldBubble).
    compact?: boolean;
}>();

const t = useT();
const { conversation, waiting, streaming, resumeQueue, bookedGroups, spentReopensAt, lastFailure } = usePaneView();
const { held, notice, reason, detail } = useHeldQueue();
const limitResend = useLimitResend(() => conversation.value);

// Once per refused turn this pane sees happen: fires when `held` turns true with a refusal reason, not for a chat opened
// on one already held. The card's failure code carries the daemon's error code (agent-domain-refused, etc.); `via` tells
// it from a refusal at the door (TurnClient.turnedAway), which hands the words back instead and shares the event name.
watch(held, (isHeld) => {
    if (isHeld && reason.value === `refused`) {
        track(`turn_refused`, { via: `held`, code: lastFailure.value?.code, agent: conversation.value.selection.provider.value });
    }
});

// The one press, worded for what it overrides: a warning it goes past, a refusal it tries again, a stop it undoes. All
// three let the hold go (TurnClient.resume), and none touches a booked message: a low-memory hold warns a person once a
// spell, so the next try runs. Only the warning's press has a hover: the risk it runs.
interface HeldPress {
    readonly label: string;
    readonly hint?: Tip | undefined;
}
// What the press lets go: the messages the hold kept, by id, so a booking beside them stays on its time. Sent only to a
// sandbox that books each message (TurnClient.resume); an older one lets its whole queue go, as it always did.
const heldIds = computed(() => waiting.value.map((message) => message.id));
const press = computed((): HeldPress => {
    switch (reason.value) {
        case `memory`:
            return { label: t(`chat.chatHeld.sendAnyway`), hint: sendAnywayTip() };
        case `stopped`:
            return { label: t(`chat.chatQueue.sendNow`), hint: spentHint.value };
        default:
            return { label: t(`agents.words.sendAgain`), hint: spentHint.value };
    }
});

// The account these would go on is spent until a named reopen: sent now they are refused before anything runs, so the
// solid press books them for the reopen instead (the press that sends them now steps back to a quiet one, since the
// reopen is the provider's estimate). Booked, they stand under the scheduled line with their own Change and Send now;
// the limit answer is set to send them again, as for any scheduled send, should the provider name that reopen too early.
// A low-memory hold is about room, not the allowance, and keeps its own press.
const spentAt = computed(() => (spentReopensAt.value === undefined ? undefined : spentReopensAt.value * 1_000));
const now = useNow(() => held.value && spentAt.value !== undefined);
const reopenAt = computed(() => {
    const at = spentAt.value;
    return at === undefined || at <= now.value || reason.value === `memory` || !supportsRoute(`agent.queueSchedule`) ? undefined : at;
});
// Sending now before that reopen, said on the press that does it: the allowance may still refuse it.
const spentHint = computed((): Tip | undefined =>
    reopenAt.value === undefined ? undefined : { title: t(`chat.chatHeld.sendNowTitle`), note: t(`chat.chatHeld.sendNowSpent`) },
);
const sendAtLabel = computed(() =>
    reopenAt.value === undefined ? `` : atReopenPhrase(
              { at: (when) => t(`chat.chatHeld.sendAt`, { when }), in: (when) => t(`chat.chatHeld.sendIn`, { when }) },
              reopenAt.value,
              now.value,
          ),
);
const sendAtHint = computed((): Tip => ({
    title: t(`chat.chatHeld.sendAtTitle`),
    rows: reopenAt.value === undefined ? [] : [{ label: t(`chat.composerIntent.sendsAt`), value: pickUpWhen(reopenAt.value, now.value) }],
    note: t(`chat.composerIntent.hintScheduledHeld`),
}));
const sendAtReopen = (): void => {
    const at = reopenAt.value;
    if (at === undefined) {
        return;
    }
    // allow(silent-catch): the write is optimistic and rolls back on failure, so the limit card's control saying `wait` is the report.
    void limitResend.arm().catch(() => undefined);
    void conversation.value.turn.reschedule({ sendAt: at }, heldIds.value);
};
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
            <!-- Marked so the bar over the composer (ChatWaitingBar) repeats a memory hold only while this line is out of view. -->
            <ChatHeldStatus :reason="reason" :detail="detail" :spread="compact" v-bind="{ [HELD_PRESS_ATTR]: `` }">
                <!-- Held means nothing goes by itself, even after a turn running now: the press lets it go, after that turn if one runs. -->
                <span class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                    <Button
                        size="small"
                        thumb
                        :tier="reopenAt === undefined ? undefined : `quiet`"
                        v-tooltip.top="press.hint"
                        @click="resumeQueue(heldIds)"
                        >{{ press.label }}</Button
                    >
                    <Button v-if="reopenAt !== undefined" size="small" thumb v-tooltip.top="sendAtHint" @click="sendAtReopen()">
                        <Icon name="clock" class="mr-1 text-2xs" />{{ sendAtLabel }}
                    </Button>
                    <!-- Only a hold that named its ceiling can be raised past (a stall names none), and never under a live turn, which the restart would kill. -->
                    <MemoryRaise v-if="notice?.noticeAction === `sandboxMemory` && !streaming" />
                </span>
            </ChatHeldStatus>
            <!-- What happens next, asked as every wall asks it (a spent allowance's card, ChatContinueStrip): wait for the
                 press, or send it by itself once memory has stayed free for a while. -->
            <div v-if="reason === `memory`" class="flex flex-col gap-1 text-2xs text-muted" :class="compact ? `items-start` : `items-end`">
                <TurnBreakQuestion ending="memory" :conversation-id="conversation.conversationId" :describe="memoryNext" :end="!compact" />
            </div>
        </template>
        <ChatHeldBooking v-for="group in bookedGroups" :key="group.ids.join(` `)" :group="group" :compact="compact" />
    </div>
</template>

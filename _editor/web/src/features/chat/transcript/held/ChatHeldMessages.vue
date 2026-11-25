<script setup lang="ts">
import { Button, Icon, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import TurnBreakQuestion from "../../panel/TurnBreakQuestion.vue";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import MemoryRaise from "../notices/MemoryRaise.vue";
import ChatHeldBooking from "./ChatHeldBooking.vue";
import ChatHeldBubble from "./ChatHeldBubble.vue";
import ChatHeldRouting from "./ChatHeldRouting.vue";
import ChatHeldStatus from "./ChatHeldStatus.vue";
import { HELD_PRESS_ATTR } from "../../panel/pane/heldLineSeen";
import { useHeldQueue } from "./heldQueue";
import { useReopenPress } from "./heldPresses";
import { useLimitResend } from "../../panel/pane/scheduledSend";
import { sendAnywayTip } from "../../../../models/agent-status/memoryTip";
import { track } from "../../../../app/analytics";
import { useAccessWall } from "../../../../models/conversations/endings/accessWall";
import { RouterLink } from "vue-router";
import { modelsHref } from "../../../../lib/routes/modelsPath";

/* What the conversation's queue holds, drawn where the reader looks for a message they just sent: at the foot of the transcript, as their own prompts. What a Stop or a refusal held is marked not sent, over the one line that says why and the one press that sends it; a low-memory hold also asks, on that same line, what happens next, as a spent allowance does. Each group of messages booked for later stands under its own line with the time it goes, its own Change and its own Send now (ChatHeldBooking). */

defineProps<{
    // The quick bar's composer, with no transcript above it: each message on one line (ChatHeldBubble).
    compact?: boolean;
}>();

const t = useT();
const { conversation, waiting, streaming, resumeQueue, bookedGroups, lastFailure, wayOut } = usePaneView();
const { held, notice, reason, detail } = useHeldQueue();

// Once per refused turn this pane sees happen: fires when `held` turns true with a refusal reason, not for a chat opened
// on one already held. The card's failure code carries the daemon's error code (agent-domain-refused, etc.); `via` tells
// it from a refusal at the door (TurnClient.turnedAway), which hands the words back instead and shares the event name.
watch(held, (isHeld) => {
    if (isHeld && reason.value === `refused`) {
        track(`turn_refused`, { via: `held`, code: lastFailure.value?.code, agent: conversation.value.selection.provider.value });
    }
});

// The one press, worded for what it overrides: a warning it goes past (memory, a short disk), a refusal it tries again, a stop it undoes. All
// three let the hold go (TurnClient.resume), and none touches a booked message: a low-memory hold warns a person once a
// spell, so the next try runs. Only the warning's press has a hover: the risk it runs.
interface HeldPress {
    readonly label: string;
    readonly hint?: Tip | undefined;
}
// What the press lets go: the messages the hold kept, by id, so a booking beside them stays on its time. Sent only to a
// sandbox that books each message (TurnClient.resume); an older one lets its whole queue go, as it always did.
const heldIds = computed(() => waiting.value.map((message) => message.id));
// The account these would go on is spent until a reopen still ahead, whatever held them, memory included: sent now they
// are refused before anything runs, so the solid press books them for the reopen and the press that sends them now steps
// back to a quiet one (heldPresses.ts, the one decision every surface drawing a held message reads).
const reopen = useReopenPress(() => held.value, useLimitResend(() => conversation.value).arm);
const reopenAt = reopen.reopenAt;
const spentHint = reopen.sendNowHint;
const sendAtLabel = reopen.label;
const sendAtHint = reopen.hint;
const sendAtReopen = (): void => reopen.bookWords(heldIds.value);
// No account of the provider can serve these (accessWall.ts): sent again they are only re-tested and held once more, so
// the press steps back to a quiet one and the card above the composer carries the fix (ChatContinueStrip). The same where
// sending them again fails the same way (`wayOut`): the card over the composer lights the way out (ChatWayOutStrip).
const accessWall = useAccessWall();
// THE FREE TRIAL COULD NOT ANSWER (busy past the sandbox's own retries, no model for this pick, or today's allowance
// spent): the words are kept, and the way to an answer that does not depend on the trial is connecting a model of the
// reader's own, so that is the bright press and sending again on the trial the quiet one. On a new cloud sandbox this is
// most first messages that fail (PostHog, 2026-11: about ten of eleven outside first turns), and the held line used to
// offer only "Send again" and say "Refused before it ran".
const TRIAL_REFUSALS: ReadonlySet<string> = new Set([`trial-unavailable`, `trial-model-unavailable`, `trial-exhausted`]);
const trialRefused = computed(() => reason.value === `refused` && TRIAL_REFUSALS.has(lastFailure.value?.code ?? ``));
// The bubbles are the words that wait; a continuation (a Continue booked for later, let go and then held) has none.
const bubbles = computed(() => waiting.value.filter((message) => message.continues !== true));
// Each group stands in a column as wide as its widest message, so its line breaks where the messages' own edge is and
// keeps to their right edge (ChatHeldStatus). Over the quick bar's composer the card is the column.
const column = (compact: boolean): string => (compact ? `flex flex-col gap-2` : `flex max-w-[85%] flex-col items-end gap-2`);
const press = computed((): HeldPress => {
    switch (reason.value) {
        case `memory`:
            return { label: t(`chat.chatHeld.sendAnyway`), hint: sendAnywayTip() };
        case `stopped`:
            return { label: t(`chat.chatQueue.sendNow`), hint: spentHint.value };
        default:
            // A short disk is said once per conversation, so the next try goes past it (checkout-admission.ts).
            return {
                label: lastFailure.value?.code === `sandbox-disk-low` ? t(`chat.chatHeld.sendAnyway`) : t(`agents.words.sendAgain`),
                hint: spentHint.value,
            };
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
        <div v-if="held" :class="column(compact)">
            <ChatHeldBubble v-for="message in bubbles" :key="message.id" :message="message" :compact="compact" />
            <!-- Marked so the bar over the composer (ChatWaitingBar) repeats a memory hold only while this line is out of view. -->
            <ChatHeldStatus :reason="reason" :detail="detail" :trial="trialRefused" :spread="compact" v-bind="{ [HELD_PRESS_ATTR]: `` }">
                <!-- Only a hold that named its ceiling can be raised past (a stall names none), and never under a live turn, which the restart would kill. -->
                <template #cause><MemoryRaise v-if="notice?.noticeAction === `sandboxMemory` && !streaming" /></template>
                <!-- What happens next, asked as every wall asks it (a spent allowance's card, ChatContinueStrip), beside the
                     press it is the other way to: wait for that press, or send it by itself once memory has stayed free. -->
                <TurnBreakQuestion v-if="reason === `memory`" ending="memory" :conversation-id="conversation.conversationId" inline />
                <!-- Held means nothing goes by itself, even after a turn running now: the press lets it go, after that turn if one runs. -->
                <Button
                    v-if="trialRefused"
                    :as="RouterLink"
                    :to="modelsHref()"
                    size="small"
                    thumb
                    :tier="reopenAt === undefined ? `accent` : `boring`"
                    data-held-connect-model
                    >{{
                    t(`chat.words.connectAModel`)
                }}</Button>
                <Button
                    size="small"
                    thumb
                    :tier="reopenAt === undefined && accessWall === undefined && wayOut === undefined && !trialRefused ? `accent` : `quiet`"
                    :disabled="reopen.blockedLine.value !== undefined"
                    v-tooltip.top="reopen.blockedHint.value ?? press.hint"
                    @click="resumeQueue(heldIds)"
                    >{{ press.label }}</Button
                >
                <Button tier="accent" v-if="reopenAt !== undefined" size="small" thumb v-tooltip.top="sendAtHint" @click="sendAtReopen()">
                    <Icon name="clock" class="mr-1 text-2xs" />{{ sendAtLabel }}
                </Button>
            </ChatHeldStatus>
            <p v-if="reopen.blockedLine.value" class="text-2xs text-muted" role="status">{{ reopen.blockedLine.value }}</p>
            <ChatHeldRouting :messages="bubbles" :compact="compact" />
        </div>
        <div v-for="group in bookedGroups" :key="group.ids.join(` `)" :class="column(compact)">
            <ChatHeldBooking :group="group" :compact="compact" />
        </div>
    </div>
</template>

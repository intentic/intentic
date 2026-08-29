<script setup lang="ts">
import { Icon, useDevice, vAction } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { useAgents } from "../composables/agents/useAgents";
import { pickUpLine } from "../composables/chat/pickUp";
import { formatWait } from "../composables/chat/usageStatus";
import { usePaneView } from "../composables/chat/useChat";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* WHAT HAPPENED TO THE LAST TURN, AND THE WAY ON, one strip for every ending that leaves work behind.
 *
 * There were three of these, and the gap between them was the bug. A turn that died with no name got a strip
 * with a Continue button. A provider outage got a different banner in a different component with a different
 * countdown. A spent allowance got a sentence in the transcript and no affordance at all, so the one ending
 * that knows exactly when the press will work was the one that made the user type the word by hand.
 *
 * They are one strip now because they are one situation: finished work behind a live session, and a press that
 * finishes the job. What varies is only what can honestly be said about WHEN, which pickUp.ts holds, and who is
 * doing the pressing, which is the pair of controls on the right.
 *
 * The armed line below is the same offer as a standing instruction, and it stays up for as long as the
 * automation does, not only alongside a stop: a switch with no readout and no way off is a trap, and a chat
 * sitting on a five-second timer is otherwise indistinguishable from one nothing is happening to. */

const props = defineProps<{
    /** The pane's reading of the pick-up: whether to say anything, and whether a press would get through now. */
    visible: boolean;
    ready: boolean;
}>();
const emit = defineEmits<{ (event: "continue"): void }>();

const { conversation, connected, pickUp, autoContinue, autoContinueAt, setAutoContinue } = usePaneView();
const { reachable } = useSandbox();
const { mobile } = useDevice();
const { setResumeAfterOutage } = useAgents();

// The clock runs only while something on screen counts down: an allowance reset, an outage retry, an armed
// continuation. Every other chat in the app pays nothing for this strip existing.
const counting = computed(
    () =>
        (props.visible && pickUp.value !== undefined && (pickUp.value.readyAt !== undefined || pickUp.value.automatic !== undefined)) ||
        autoContinueAt.value !== undefined,
);
const now = useNow(() => counting.value);

// The daemon's breaker names how many tries this outage has left; the sentence spends them out loud, because an
// automation spending the user's allowance while they watch has to account for itself.
const attempts = computed(() => {
    const outage = conversation.value.failures.outageResume.value;
    return outage === undefined ? undefined : { attempt: outage.attempt, maxAttempts: outage.maxAttempts };
});
const line = computed(() => (pickUp.value === undefined ? `` : pickUpLine(pickUp.value, attempts.value, now.value)));
/* What the press promises, and it promises two different things now. A HELD turn is sent again exactly as it
 * was, so the honest word is "again": nothing is added to the conversation, which is what makes pressing it
 * twice free and is worth saying to someone who has just watched an allowance refuse them.
 *
 * The waiting hint survives for the endings with nothing held, which are the only ones a wait still gates
 * (pickUpReady). It owes the reader the one thing "disabled" never says: why, and until when. */
const continueHint = computed(() => {
    if (pickUp.value?.held !== undefined) {
        return `Send this turn again, exactly as it was: nothing is added to the chat`;
    }
    return props.ready ? `Pick up where it left off, without retyping` : `Waiting: nothing gets through until the allowance resets`;
});

/* THE OUTAGE'S OWN PAIR OF CONTROLS, which no other ending has, because no other ending has a second party
 * already working on it. Arming is the daemon's per-conversation override, and disarming is the same press
 * pointing the other way: a press that starts something automatic and can only be undone from a settings page
 * is how people learn not to press it.
 *
 * THE PRESS ARMS THIS CHAT AND NOTHING ELSE. It used to write the sandbox-wide setting, and the gap between
 * what the button looked like (one line, one conversation, one dead turn) and what it did was the whole bug: a
 * person finishing one piece of work at midnight silently signed every agent on the board up to re-run its
 * turns on their allowance. The standing default stays where a standing policy belongs, in Sandbox ▸ Agent, and
 * the notice the press writes is what says so. */
const outage = computed(() => (pickUp.value?.reason === `outage` ? pickUp.value : undefined));
const arming = ref(false);
const setOutageResume = async (resume: boolean): Promise<void> => {
    if (!reachable.value || arming.value) {
        return;
    }
    arming.value = true;
    try {
        await setResumeAfterOutage(conversation.value.conversationId, resume);
        if (resume) {
            conversation.value.failures.armOutageResume();
            return;
        }
        conversation.value.failures.disarmOutageResume();
    } catch {
        // Left as it stands, in both directions: the offer stays up to press again and the countdown stays
        // honest until the daemon has actually been told otherwise. A strip that vanished on a failed write
        // would claim a resume nobody armed.
    } finally {
        arming.value = false;
    }
};

const autoContinueStrip = computed(() => autoContinue.value && connected.value);
const autoContinueLine = computed(() =>
    autoContinueAt.value === undefined
        ? `Auto-continue is on: this chat picks itself back up when a turn stops short.`
        : `Auto-continue is on, continuing in ${formatWait(autoContinueAt.value / 1000, now.value)}.`,
);
</script>

<template>
    <div
        v-if="visible"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line-strong bg-card px-3 py-2 text-2xs text-muted"
    >
        <Icon :name="ready ? `pause` : `clock`" class="shrink-0" />
        <span class="min-w-0 flex-1">{{ line }}</span>
        <!-- The way back out of the automation, in the surface that armed it. -->
        <button
            v-if="outage?.automatic !== undefined"
            type="button"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-muted transition-colors hover:bg-primary-600/15 hover:text-link disabled:opacity-50"
            :disabled="!reachable || arming"
            v-tooltip.top="'Stop this chat picking the turn back up by itself'"
            v-action="() => setOutageResume(false)"
        >
            Stop
        </button>
        <!-- ...and into it. The words are what the press DOES ("this chat", "keep going") rather than the name
             of a setting: the old copy admitted the blast radius in a parenthesis, which is exactly the place
             nobody reads before pressing, and the honest fix was to make the press smaller. -->
        <button
            v-else-if="outage !== undefined"
            type="button"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-muted transition-colors hover:bg-primary-600/15 hover:text-link disabled:opacity-50"
            :disabled="!reachable || arming"
            v-tooltip.top="'Keep trying this turn until the provider answers'"
            v-action="() => setOutageResume(true)"
        >
            Keep this chat going
        </button>
        <!-- The standing version of the press, offered where the wish for it happens: reading this line for the
             third time in half an hour. Only while it is OFF; armed, the strip below carries both the state and
             the way out of it. Absent while the daemon is already retrying: two automations on one stopped turn
             is the thing this whole state exists to prevent. -->
        <button
            v-if="!autoContinue && outage?.automatic === undefined"
            type="button"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-muted transition-colors hover:bg-primary-600/15 hover:text-link disabled:opacity-50"
            :disabled="!reachable"
            v-tooltip.top="'Keep pressing Continue for me whenever a turn stops short'"
            @click="setAutoContinue(true)"
        >
            Auto-continue
        </button>
        <!-- The press itself. Present but inert while the pick-up is still waiting on an instant it named: a
             button that disappears until the reset takes the promise with it, and the promise is the point.
             The key is named ON the button rather than in a tooltip, because a pointer that has travelled here
             has already spent what the shortcut would have saved; the composer's hint slot says the same thing
             one line below, for the reader who hasn't moved yet. -->
        <button
            type="button"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15 disabled:opacity-50"
            :disabled="!reachable || !ready"
            v-tooltip.top="continueHint"
            @click="emit(`continue`)"
        >
            Continue<span v-if="!mobile && ready" class="font-normal text-subtle"> · Enter</span>
        </button>
    </div>
    <!-- WHAT AN ARMED CHAT LOOKS LIKE WHILE IT WAITS ON ITSELF. On screen for as long as the automation is,
         because a switch with no off is a trap. -->
    <div
        v-if="autoContinueStrip"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line-strong bg-card px-3 py-2 text-2xs text-muted"
    >
        <Icon name="repeat" class="shrink-0" />
        <span class="min-w-0 flex-1">{{ autoContinueLine }}</span>
        <button
            type="button"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15"
            v-tooltip.top="'Stop continuing this chat by itself'"
            @click="setAutoContinue(false)"
        >
            Turn off
        </button>
    </div>
</template>

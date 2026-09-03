<script setup lang="ts">
import { Button, Icon, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { useAgents } from "../composables/agents/useAgents";
import { fallbackAccount, fallbackLabel } from "../composables/chat/limitFallback";
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

const { conversation, connected, pickUp, autoContinue, autoContinueAt, setAutoContinue, provider, model, account, accounts, selectAccount } =
    usePaneView();
const { reachable } = useSandbox();
const { mobile } = useDevice();
const { setResumeAfterOutage, setResumeAfterLimit } = useAgents();

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

/* THE SAME PAIR FOR THE OTHER WAIT, and the case for offering it here is stronger than the outage's. An outage
 * is over in minutes and is met by whoever is in the room; an allowance reopens hours later, so the person who
 * would want this armed is looking at the line that just told them so, and by the time it fires they are
 * elsewhere. That is the whole of what arming buys, and it has to be offered at the moment of the wish.
 *
 * ONLY WITH AN INSTANT TO AIM AT. An armed limit is an appointment (the daemon's pass fires once, at the hour
 * the provider published), so with no hour there is nothing to arm and the button does not appear: an offer
 * that quietly does nothing is worse than no offer. */
const limitWait = computed(() => (pickUp.value?.reason === `limit` && pickUp.value.readyAt !== undefined ? pickUp.value : undefined));
const setLimitResume = async (resume: boolean): Promise<void> => {
    if (!reachable.value || arming.value) {
        return;
    }
    arming.value = true;
    try {
        await setResumeAfterLimit(conversation.value.conversationId, resume);
        if (resume) {
            conversation.value.failures.armLimitResume();
            return;
        }
        conversation.value.failures.disarmLimitResume();
    } catch {
        // Left as it stands, both ways, for the reason its outage twin gives: a strip that redrew itself over a
        // failed write would be claiming a resume nobody armed.
    } finally {
        arming.value = false;
    }
};

/* THE WAY ON THAT DOES NOT INVOLVE WAITING, offered in the one place the wait is announced.
 *
 * Every other control on this strip is about WHEN: arm the appointment, count down to it, press when it opens.
 * None of them is any use to someone with a second subscription connected and work in front of them, and the
 * two gestures that were the answer — pick another account in the composer's switcher, then press Continue —
 * had nothing on screen relating them. So the offer is made here, as one press.
 *
 * Read off the pick-up's REASON rather than off `limitWait` below, which additionally requires a reset instant:
 * an appointment needs an hour to aim at, and this needs nothing but another pool. A limit whose reset the
 * provider never published is precisely when a person is most stuck, and it was the case with no affordance
 * at all.
 *
 * limitFallback.ts holds the judgement about which account may be offered, and why it is only ever one with a
 * reading that has room in it. */
const spentLimit = computed(() => (pickUp.value?.reason === `limit` ? pickUp.value : undefined));
const fallback = computed(() =>
    spentLimit.value === undefined
        ? undefined
        : fallbackAccount(provider.value, account.value, accounts.value, model.value === `` ? undefined : { id: model.value }),
);

/* Point the conversation at the other account and make the press the strip already owns. Two steps rather than
 * a route of its own, because the daemon needs no new verb: `selectAccount` writes the credential the next turn
 * names and `resumeHeldTurn` sends the HELD turn under it (its `routing.account` is read from the conversation),
 * so the same work goes again on a pool that has room. The write is synchronous, so the emit below is already
 * carrying the new account rather than racing it. */
const continueOnFallback = (): void => {
    const target = fallback.value;
    if (target === undefined || !reachable.value) {
        return;
    }
    selectAccount(target.id);
    emit(`continue`);
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
        <!-- A FLOOR, not `min-w-0`, and the row does not survive without one. Every control beside this is
             `shrink-0` and the sentence was the only thing that could yield, so flexbox took the whole overflow
             out of the TEXT instead of wrapping the buttons it cannot shrink: at 520px the line broke over three
             rows, at 340px it reached one word per line and a 274px-tall strip. `flex-wrap` was already on the
             container and never engaged, because an item that can shrink to nothing means the line always
             "fits". Given a floor it engages, and the buttons drop to their own row, which is what wrapping is
             for. Sized so the longest of these sentences stays a readable paragraph rather than a column. -->
        <span class="min-w-[14rem] flex-1">{{ line }}</span>
        <!-- The way back out of the automation, in the surface that armed it. -->
        <Button
            v-if="outage?.automatic !== undefined"
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
            :disabled="!reachable || arming"
            v-tooltip.top="'Stop this chat picking the turn back up by itself'"
            @click="() => setOutageResume(false)"
        >
            Stop
        </Button>
        <!-- ...and into it. The words are what the press DOES ("this chat", "keep going") rather than the name
             of a setting: the old copy admitted the blast radius in a parenthesis, which is exactly the place
             nobody reads before pressing, and the honest fix was to make the press smaller. -->
        <Button
            v-else-if="outage !== undefined"
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
            :disabled="!reachable || arming"
            v-tooltip.top="'Keep trying this turn until the provider answers'"
            @click="() => setOutageResume(true)"
        >
            Keep this chat going
        </Button>
        <!-- The allowance's own pair, in the same slot and the same order: the way out first for a chat that is
             already armed, the way in for one that is not. The words name the appointment rather than a retry,
             because that is the difference between the two waits: this fires once, when the provider said the
             window reopens. -->
        <Button
            v-else-if="limitWait?.automatic !== undefined"
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
            :disabled="!reachable || arming"
            v-tooltip.top="'Stop this chat sending the turn again by itself'"
            @click="() => setLimitResume(false)"
        >
            Stop
        </Button>
        <Button
            v-else-if="limitWait !== undefined"
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
            :disabled="!reachable || arming"
            v-tooltip.top="'Send this turn again by itself, once the allowance comes back'"
            @click="() => setLimitResume(true)"
        >
            Send it when it's back
        </Button>
        <!-- THE WAY ON THAT ISN'T WAITING. Ahead of Continue because on a spent allowance Continue is the
             control that cannot work yet, and behind the appointment pair because arming is the answer for
             someone who is leaving and this is the answer for someone who is staying. Names the account rather
             than the act ("Continue on radarsu"), so it reads as the same press with the one thing that differs
             appended — which is exactly what it is. -->
        <Button
            v-if="fallback !== undefined"
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
            :disabled="!reachable"
            v-tooltip.top="`Send this turn again now, on ${fallbackLabel(fallback)}'s allowance, instead of waiting for this one`"
            @click="continueOnFallback"
        >
            Continue on {{ fallbackLabel(fallback) }}
        </Button>
        <!-- The standing version of the press, offered where the wish for it happens: reading this line for the
             third time in half an hour. Only while it is OFF; armed, the strip below carries both the state and
             the way out of it. Absent while the daemon is already retrying: two automations on one stopped turn
             is the thing this whole state exists to prevent. -->
        <Button
            v-if="!autoContinue && outage?.automatic === undefined"
            size="small"
            severity="secondary"
            :text="true"
            class="shrink-0"
            :disabled="!reachable"
            v-tooltip.top="'Keep pressing Continue for me whenever a turn stops short'"
            @click="setAutoContinue(true)"
        >
            Auto-continue
        </Button>
        <!-- The press itself. Present but inert while the pick-up is still waiting on an instant it named: a
             button that disappears until the reset takes the promise with it, and the promise is the point.
             The key is named ON the button rather than in a tooltip, because a pointer that has travelled here
             has already spent what the shortcut would have saved; the composer's hint slot says the same thing
             one line below, for the reader who hasn't moved yet. -->
        <Button size="small" :text="true" class="shrink-0" :disabled="!reachable || !ready" v-tooltip.top="continueHint" @click="emit(`continue`)">
            Continue<span v-if="!mobile && ready" class="font-normal text-subtle"> · Enter</span>
        </Button>
    </div>
    <!-- WHAT AN ARMED CHAT LOOKS LIKE WHILE IT WAITS ON ITSELF. On screen for as long as the automation is,
         because a switch with no off is a trap. -->
    <div
        v-if="autoContinueStrip"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line-strong bg-card px-3 py-2 text-2xs text-muted"
    >
        <Icon name="repeat" class="shrink-0" />
        <span class="min-w-0 flex-1">{{ autoContinueLine }}</span>
        <Button size="small" :text="true" class="shrink-0" v-tooltip.top="'Stop continuing this chat by itself'" @click="setAutoContinue(false)">
            Turn off
        </Button>
    </div>
</template>

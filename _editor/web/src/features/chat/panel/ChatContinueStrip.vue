<script setup lang="ts">
import { Button, formatTokens, Icon, ResponsiveOverlay, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useAgents } from "../../agents/fleet/useAgents";
import { fallbackAccount, fallbackLabel } from "../session/limitFallback";
import { askLimitReset, claimLimitReset, limitResetFor, limitResetNote } from "../session/limitReset";
import { pickUpStatus, pressCost } from "../run/pickUp";
import { formatWait } from "../session/usageStatus";
import { usePaneView } from "./useChat-view";
import { useSandbox } from "../../sandbox/client/useSandbox";

/* WHAT HAPPENED TO THE LAST TURN, AND THE WAY ON, one strip for every ending that leaves work behind.
 *
 * There were three of these, and the gap between them was the bug. A turn that died with no name got a strip
 * with a Continue button. A provider outage got a different banner in a different component with a different
 * countdown. A spent allowance got a sentence in the transcript and no affordance at all, so the one ending
 * that knows exactly when the press will work was the one that made the user type the word by hand.
 *
 * They are one strip now because they are one situation: finished work behind a live session, and a press that
 * finishes the job. What varies is only what can honestly be said about WHEN, which pickUp.ts holds, and who is
 * doing the pressing, which is the controls on the right.
 *
 * ONE ROW, RANKED, which is the second thing this had to learn. Every way on had arrived as another button of
 * the same weight beside the last, and a spent allowance ended up carrying four of them under two lines of
 * prose: send it when it's back, continue on the other account, auto-continue, continue. Four equal choices is
 * not a choice, it is a paragraph in button form, and it is read by someone who has just been refused. So the
 * row now says what the three groups actually are:
 *
 *   THE STATE          one line, three facts, never a paragraph (pickUp.ts)
 *   THIS ENDING'S WAIT the one control that is about the second party: arm the appointment, or call it off
 *   THE PRESS          Continue, with its variants folded behind the caret beside it
 *
 * WHY THE VARIANTS ARE A MENU AND NOT MORE BUTTONS. "Continue on the other account" and "auto-continue" are the
 * same verb with something changed, one names a different pool and one makes the press standing. A menu hung on
 * the press says exactly that relationship, costs one click for the rarer answer, and stops the two of them
 * competing for attention with the answer nearly everybody wants, which is the press itself. The caret only
 * appears when the menu has something in it.
 *
 * The armed line below is the same offer as a standing instruction, and it stays up for as long as the
 * automation does, not only alongside a stop: a switch with no readout and no way off is a trap, and a chat
 * sitting on a five-second timer is otherwise indistinguishable from one nothing is happening to. */

const props = defineProps<{
    /** The pane's reading of the pick-up: whether to say anything, and whether a press would get through now. */
    visible: boolean;
    ready: boolean;
}>();
// The press, and whether it keeps the provider session across an account change (the menu's carrying variant).
const emit = defineEmits<{ (event: "continue", options?: { readonly carry?: boolean }): void }>();

const { conversation, connected, pickUp, autoContinue, autoContinueAt, setAutoContinue, provider, model, account, accounts, selectAccount } =
    usePaneView();
const { reachable } = useSandbox();
const { mobile } = useDevice();
const { agentById, setResumeAfterOutage, setResumeAfterLimit } = useAgents();

// The clock runs only while something on screen counts down: an allowance reset, an outage retry, an armed
// continuation. Every other chat in the app pays nothing for this strip existing.
const counting = computed(
    () =>
        (props.visible && pickUp.value !== undefined && (pickUp.value.readyAt !== undefined || pickUp.value.automatic !== undefined)) ||
        autoContinueAt.value !== undefined,
);
const now = useNow(() => counting.value);

// The daemon's breaker names how many tries this outage has left; the line spends them out loud, because an
// automation spending the user's allowance while they watch has to account for itself.
const attempts = computed(() => {
    const outage = conversation.value.failures.outageResume.value;
    return outage === undefined ? undefined : { attempt: outage.attempt, maxAttempts: outage.maxAttempts };
});
const status = computed(() => (pickUp.value === undefined ? `` : pickUpStatus(pickUp.value, attempts.value, now.value)));

/* What the press promises, and it promises two different things now. A HELD turn is sent again exactly as it
 * was, so the honest word is "again": nothing is added to the conversation, which is what makes pressing it
 * twice free and is worth saying to someone who has just watched an allowance refuse them. It also carries the
 * caveat the line used to spend a clause on, in the one place it is read at the moment it applies: the reset is
 * the provider's own guess, it is routinely early, and pressing before it costs one refused request.
 *
 * The waiting hint survives for the endings with nothing held, which are the only ones a wait still gates
 * (pickUpReady). It owes the reader the one thing "disabled" never says: why, and until when. */
/* WHAT THE PRESS COSTS, said on the press, because it is the one thing "Continue" used to hide: a held turn
 * that ran resumes its session and re-reads the whole context, cold (the cache is per account and has expired
 * by the time anyone presses); one refused at the door opens a fresh session with the sandbox's hand-off, a
 * few thousand tokens. The daemon measured both at the failure (PickUp.held); a hold it did not measure says
 * nothing rather than guessing. */
const pressCostLine = computed(() => {
    const cost = pressCost(pickUp.value?.held);
    if (cost === undefined) {
        return ``;
    }
    return cost.kind === `reread`
        ? ` It re-reads ~${formatTokens(cost.tokens)} tokens of context, cold.`
        : ` It opens a fresh session with a ~${formatTokens(cost.tokens)}-token hand-off.`;
});
const continueHint = computed(() => {
    const keyHint = !mobile.value && props.ready ? ` (Enter)` : ``;
    if (pickUp.value?.held !== undefined) {
        return `Send this turn again, exactly as it was: nothing is added to the chat.${pressCostLine.value} The reset is a due date, not a wall — an earlier press may get through${keyHint}`;
    }
    return props.ready ? `Pick up where it left off, without retyping${keyHint}` : `Waiting: nothing gets through until the allowance resets`;
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
 * elsewhere. That is the whole of what arming buys, and it has to be offered at the moment of the wish, which
 * is why it holds a slot of its own in the row rather than going into the menu with the press's variants.
 *
 * ONLY WITH AN INSTANT TO AIM AT. An armed limit is an appointment (the daemon's pass fires once, at the hour
 * the provider published), so with no hour there is nothing to arm and the button does not appear: an offer
 * that quietly does nothing is worse than no offer. */
// ...and never beside a booked MOVE: that wait is the policy's, not the appointment's, and a Stop here would
// disarm the wrong thing.
const limitWait = computed(() =>
    pickUp.value?.reason === `limit` && pickUp.value.readyAt !== undefined && pickUp.value.held?.moving === undefined ? pickUp.value : undefined,
);
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
 * had nothing on screen relating them. So the offer is made here, as one press, in the menu on the press it is
 * a variant of.
 *
 * Read off the pick-up's REASON rather than off `limitWait` above, which additionally requires a reset instant:
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

/* THE WAY PAST THE WALL ITSELF, which is the only control on this strip that changes whether a press can work
 * rather than when.
 *
 * A five-hour window at 100% beside a weekly allowance a third full is the commonest refusal in this app, and
 * the provider will reopen that window on demand, once a week, leaving the weekly pool alone. Every affordance
 * beside this one answers the wall by routing around it (another account) or by outliving it (an appointment,
 * a countdown); this one removes it, on the account the user is already on, and it was the answer nobody could
 * reach from here. limitReset.ts holds the mechanism and why the offer is the provider's answer rather than
 * anything inferred from a full meter.
 *
 * WHICH ACCOUNT IS BEING ASKED ABOUT, and why the composer's selection is not enough on its own: a chat that
 * names nobody ("anyone") still ran its refused turn on a particular account, and that is the one holding the
 * grant. The conversation's own pick wins when it has one, because the user may have re-pointed the chat since
 * it was refused, and then the press they are about to make is on the account they chose. */
const limitAccount = computed(() =>
    spentLimit.value === undefined ? undefined : (account.value ?? agentById(conversation.value.conversationId)?.account),
);
// Asked when the strip appears and not again: the answer only matters while this line is on screen, and the
// probe tells the provider the account is at the wall, which is a claim worth making only while it is true.
watch(limitAccount, (id) => void askLimitReset(id, conversation.value.box.value), { immediate: true });
const resetOffer = computed(() => (limitAccount.value === undefined ? undefined : limitResetFor(limitAccount.value)));

/* The press, and the one control here that spends something scarce, hence its own in-flight flag and its own
 * sentence when it comes back having changed nothing. A claim that succeeds continues immediately: the window
 * is open, the turn is held, and making the user press a second button to use what they just spent would be
 * the two-gesture problem this strip exists to end.
 *
 * WHETHER THE BUTTON SURVIVES ITS OWN FAILURE is limitReset.ts's answer, not this component's, and the two
 * outcomes differ: an answer ABOUT the account (already spent, not eligible, no longer limited) retires the
 * offer and leaves the note to explain the button's absence; an answer that never arrived spent nothing and
 * proved nothing, so the press stays and the note sits under it. A failure that took away the only way to
 * retry it would be the worse of the two mistakes.
 *
 * The note itself goes on its own line rather than into the row, for the reason its markup gives: it is a
 * sentence, and a sentence in a row of labels is what makes the row stop being readable. */
const resetting = ref(false);
const resetNote = ref<string>();
const canReset = computed(() => resetOffer.value?.available === true);
const useLimitReset = async (): Promise<void> => {
    const id = limitAccount.value;
    if (id === undefined || !reachable.value || resetting.value) {
        return;
    }
    resetting.value = true;
    resetNote.value = undefined;
    try {
        const claim = await claimLimitReset(id, conversation.value.box.value);
        if (claim.result === `reset`) {
            emit(`continue`);
            return;
        }
        resetNote.value = limitResetNote(claim);
    } finally {
        resetting.value = false;
    }
};

/* THE STANDING VERSION OF THE PRESS, offered where the wish for it happens: reading this line for the third
 * time in half an hour. Only while it is OFF; armed, the strip below carries both the state and the way out of
 * it. Absent while the daemon is already retrying: two automations on one stopped turn is the thing this whole
 * state exists to prevent.
 *
 * It sits in the menu rather than the row because it is the odd one out among these controls: the others answer
 * "what happens to THIS turn", and this one is a preference that outlives the failure entirely. A preference
 * with the same visual weight as the way out of the thing on screen is how a row stops being readable. */
const offerAutoContinue = computed(() => !autoContinue.value && outage.value?.automatic === undefined);

/* WHAT GOES IN THE ROW AND WHAT GOES BEHIND THE CARET, which is a ranking rather than a layout: the row holds
 * the state, this ending's wait, and the press, and anything else is a variant of the press.
 *
 * Auto-continue rides inline in the overwhelmingly common two-action case (Continue and Auto-continue), where
 * a menu would cost a click to reveal a single item. It goes back behind the caret as soon as there is a
 * genuine variant to rank it against, because three ways on plus a preference is the paragraph-in-button-form
 * this strip's header argues against.
 *
 * THE RESET IS THE ONE THING THAT IS NOT A VARIANT. Everything in the menu answers the wall by going around it
 * or waiting it out, on some other account or at some other hour; the reset removes the wall, here, now, and
 * it is offered for at most one moment a week — so it is in the row, and the menu items step aside for it. */
const showInlineAutoContinue = computed(() => fallback.value === undefined && !canReset.value && offerAutoContinue.value);
const hasMenu = computed(() => fallback.value !== undefined || (canReset.value && offerAutoContinue.value));
const waysOpen = ref(false);
const waysAnchor = ref<HTMLElement>();
// A menu whose strip has gone, or whose contents have, is a panel floating over an answer nobody asked for:
// both of the things that can empty it also close it.
watch(
    () => props.visible && hasMenu.value,
    (open) => {
        if (!open) {
            waysOpen.value = false;
        }
    },
);

/* Point the conversation at the other account and make the press the strip already owns. Two steps rather than
 * a route of its own, because the daemon needs no new verb: `selectAccount` writes the credential the next turn
 * names and `resumeHeldTurn` sends the HELD turn under it (its `routing.account` is read from the conversation),
 * so the same work goes again on a pool that has room. The write is synchronous, so the emit below is already
 * carrying the new account rather than racing it.
 *
 * TWO WAYS ACROSS, and the menu names both with their price rather than choosing for the reader. `carry` keeps
 * the provider session: the model keeps everything it knew, and their allowance re-reads all of it once, cold.
 * Fresh opens a new session seeded from the record and the sandbox's measured brief: a few thousand tokens,
 * and whatever never reached the record is gone. A turn refused at the door has nothing worth carrying, so it
 * gets the fresh row alone. */
const continueOnFallback = (carry: boolean): void => {
    const target = fallback.value;
    if (target === undefined || !reachable.value) {
        return;
    }
    waysOpen.value = false;
    selectAccount(target.id);
    emit(`continue`, { carry });
};
const canCarry = computed(() => pickUp.value?.held?.ran === true);
const carryLine = computed(() => {
    const tokens = pickUp.value?.held?.contextTokens;
    return tokens === undefined
        ? `Keeps this session: the model keeps everything, and re-reads all of it once on their allowance.`
        : `Keeps this session: the model keeps everything, and re-reads ~${formatTokens(tokens)} tokens once on their allowance.`;
});
const freshLine = computed(() => {
    const tokens = pickUp.value?.held?.handoffTokens;
    const cost = tokens === undefined ? `a short hand-off` : `a ~${formatTokens(tokens)}-token hand-off`;
    return `A fresh session on their allowance, seeded with ${cost} of the record and the measured state; detail not in the record is lost.`;
});

const armAutoContinue = (): void => {
    waysOpen.value = false;
    setAutoContinue(true);
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
             `shrink-0` and the status was the only thing that could yield, so flexbox took the whole overflow
             out of the TEXT instead of wrapping the buttons it cannot shrink: at 520px the line broke over three
             rows, at 340px it reached one word per line and a 274px-tall strip. `flex-wrap` was already on the
             container and never engaged, because an item that can shrink to nothing means the line always
             "fits". Given a floor it engages, and the controls drop to their own row, which is what wrapping is
             for. The line is a status rather than a paragraph now, so the floor is what one of these fits in
             rather than what one of them reads well at. -->
        <span class="min-w-[11rem] flex-1">{{ status }}</span>
        <!-- THIS ENDING'S WAIT, and the way into or out of it: one slot, four fillings, never two at once. The
             way out comes first for a chat that is already armed, the way in for one that is not. -->
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
        <!-- The allowance's own pair, in the same slot and the same order. The words name the appointment rather
             than a retry, because that is the difference between the two waits: this fires once, when the
             provider said the window reopens. -->
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
            v-tooltip.top="`Send this turn again by itself, once the allowance comes back.${pressCostLine}`"
            @click="() => setLimitResume(true)"
        >
            Send it when it's back
        </Button>
        <!-- THE PRESS AND ITS VARIANTS: the reset when the provider is granting one, Continue, inline
             Auto-continue when there are only 2 actions, or a chevron dropdown when variants exist. -->
        <div ref="waysAnchor" class="flex shrink-0 items-center gap-1">
            <!-- WHAT IT SPENDS, ON THE CONTROL THAT SPENDS IT. A once-a-week grant is exactly the kind of
                 thing somebody presses and then wishes they had been told about, and the tooltip is the last
                 place it can be said before it is gone. The weekly allowance surviving is half the point: it
                 is why this is worth pressing at all with a weekly pool that still has room in it. -->
            <Button
                v-if="canReset"
                size="small"
                severity="secondary"
                :text="true"
                :disabled="!reachable || resetting"
                v-tooltip.top="'Reopen this account\'s session limit now — spends one of its weekly resets. Your weekly allowance is untouched and still applies'"
                @click="useLimitReset"
            >
                <Icon name="refresh" class="mr-1 text-2xs" />{{ resetting ? `Resetting…` : `Reset limit now` }}
            </Button>
            <Button
                v-if="showInlineAutoContinue"
                size="small"
                severity="secondary"
                :text="true"
                :disabled="!reachable"
                v-tooltip.top="'Keep continuing automatically whenever a turn stops short'"
                @click="armAutoContinue"
            >
                <Icon name="repeat" class="mr-1 text-2xs" />Auto-continue
            </Button>
            <Button size="small" :text="true" :disabled="!reachable || !ready" v-tooltip.top="continueHint" @click="emit(`continue`)">
                Continue
            </Button>
            <Button
                v-if="hasMenu"
                size="small"
                severity="secondary"
                :text="true"
                :disabled="!reachable"
                aria-label="Other ways on"
                :aria-expanded="waysOpen"
                v-tooltip.top="'Other ways on'"
                @click="waysOpen = !waysOpen"
            >
                <Icon name="chevron-down" class="text-2xs" />
            </Button>
        </div>
        <!-- WHAT CAME BACK WHEN THE RESET CHANGED NOTHING, on a line of its own inside the same card.
             `basis-full` rather than a slot in the row: these are sentences, not labels — the shortest is 35
             characters and the commonest 52 — and inline they made the status yield past its floor and wrap,
             which put a two-line paragraph and five controls on the one row this strip's header exists to keep
             ranked. Below the controls in reading order, because that is what it is: what happened when you
             pressed the thing above it. -->
        <span v-if="resetNote !== undefined" class="basis-full text-2xs text-subtle">{{ resetNote }}</span>
    </div>
    <!-- THE PRESS'S VARIANTS: shown in the dropdown when multiple alternative ways on exist. -->
    <ResponsiveOverlay v-model="waysOpen" :anchor="waysAnchor" cross="end" header="Other ways on" panel-class="w-80 p-1">
        <div class="flex flex-col p-1">
            <!-- The other account, twice where the session is worth carrying: the same press at two prices,
                 each said on its row, so the reader chooses between fidelity and tokens rather than between
                 two buttons that look alike. -->
            <button
                v-if="fallback !== undefined && canCarry"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="() => continueOnFallback(true)"
            >
                <Icon name="user" class="mt-0.5 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-sm text-content md:text-xs">Continue on {{ fallbackLabel(fallback) }}, keeping this session</span>
                    <span class="text-2xs text-subtle">{{ carryLine }}</span>
                </span>
            </button>
            <button
                v-if="fallback !== undefined"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="() => continueOnFallback(false)"
            >
                <Icon name="user" class="mt-0.5 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-sm text-content md:text-xs">Continue on {{ fallbackLabel(fallback) }}{{ canCarry ? `, in a fresh session` : `` }}</span>
                    <span class="text-2xs text-subtle">{{ freshLine }}</span>
                </span>
            </button>
            <button
                v-if="offerAutoContinue"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="armAutoContinue"
            >
                <Icon name="repeat" class="mt-0.5 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="text-sm text-content md:text-xs">Auto-continue</span>
                    <span class="text-2xs text-subtle">Keeps continuing whenever a turn stops short.</span>
                </span>
            </button>
        </div>
    </ResponsiveOverlay>
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

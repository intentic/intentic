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

// One strip for every ending that leaves work behind (a dead turn, an outage, a spent allowance): finished work
// behind a live session, and a press that finishes it. The row is ranked — state, this ending's wait, then the
// press with its variants folded into a menu beside it. An armed automation stays visible, with an off switch,
// for as long as it runs.

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

// The clock runs only while something on screen counts down (a reset, an outage retry, an armed continuation).
const counting = computed(
    () =>
        (props.visible && pickUp.value !== undefined && (pickUp.value.readyAt !== undefined || pickUp.value.automatic !== undefined)) ||
        autoContinueAt.value !== undefined,
);
const now = useNow(() => counting.value);

// The daemon's breaker names the outage's remaining tries; the line spends them out loud.
const attempts = computed(() => {
    const outage = conversation.value.failures.outageResume.value;
    return outage === undefined ? undefined : { attempt: outage.attempt, maxAttempts: outage.maxAttempts };
});
const status = computed(() => (pickUp.value === undefined ? `` : pickUpStatus(pickUp.value, attempts.value, now.value)));

// A held turn resends unchanged: nothing is added to the conversation, so pressing it twice is free. The reset
// shown is the provider's own guess and is routinely early; pressing before it costs one refused request.
// Press cost, shown to un-hide it: a held turn that ran re-reads its whole context cold; one refused at the door
// opens a fresh session with a short hand-off (both measured by the daemon at failure, PickUp.held).
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

// The outage's own arm/disarm pair: no other ending has a second party already retrying it, and this arms only
// this chat, not the sandbox-wide default (Settings ▸ Agent).
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
        // Left as it stands either way: a strip that vanished on a failed write would claim a resume nobody armed.
    } finally {
        arming.value = false;
    }
};

// Same pair for the allowance wait: it earns a slot of its own, not the menu, since the wish to arm it happens the
// moment the line appears, hours before it fires. Only shown with an instant to aim at — an armed limit is a
// one-time appointment.
// Never beside a booked move: that wait is the policy's, not the appointment's, and Stop disarms the wrong one.
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
        // Left as it stands, both ways, for the same reason as its outage twin.
    } finally {
        arming.value = false;
    }
};

// The way on that skips waiting entirely, offered where the wait is announced: read off the reason (not
// `limitWait`, which also needs a reset instant) since this needs only another pool. limitFallback.ts judges which
// account may be offered.
const spentLimit = computed(() => (pickUp.value?.reason === `limit` ? pickUp.value : undefined));
const fallback = computed(() =>
    spentLimit.value === undefined
        ? undefined
        : fallbackAccount(provider.value, account.value, accounts.value, model.value === `` ? undefined : { id: model.value }),
);

// The only control here that changes whether a press can work, rather than when: reopens the account's five-hour
// window on demand (once a week), leaving the weekly pool alone. Asked about the conversation's own account pick
// when it has one, since the chat may have been re-pointed since the refusal; limitReset.ts holds the mechanism.
const limitAccount = computed(() =>
    spentLimit.value === undefined ? undefined : (account.value ?? agentById(conversation.value.conversationId)?.account),
);
// Asked once, when the strip appears: the probe claims the account is at the wall, true only while shown.
watch(limitAccount, (id) => void askLimitReset(id, conversation.value.box.value), { immediate: true });
const resetOffer = computed(() => (limitAccount.value === undefined ? undefined : limitResetFor(limitAccount.value)));

// The one control that spends something scarce: a successful claim continues immediately rather than making the
// user press Continue too. Whether the button survives its own failure is limitReset.ts's call — an answer about
// the account retires it, a failed request leaves it to retry.
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

// Standing version of the press, offered only while off (armed, the strip below carries the state and the way
// out) and never while the daemon is already retrying. Lives in the menu since it's a preference outliving the
// failure, not an answer about this turn.
const offerAutoContinue = computed(() => !autoContinue.value && outage.value?.automatic === undefined);

// Row vs. menu is a ranking: the row holds state, this ending's wait, and the press; everything else is a press
// variant. Auto-continue rides inline only in the two-action case; the reset is never a variant, since it removes
// the wall rather than routing around it.
const showInlineAutoContinue = computed(() => fallback.value === undefined && !canReset.value && offerAutoContinue.value);
const hasMenu = computed(() => fallback.value !== undefined || (canReset.value && offerAutoContinue.value));
const waysOpen = ref(false);
const waysAnchor = ref<HTMLElement>();
// Both things that can empty the menu also close it: an empty strip shouldn't leave a floating panel behind.
watch(
    () => props.visible && hasMenu.value,
    (open) => {
        if (!open) {
            waysOpen.value = false;
        }
    },
);

// Two steps, not a new daemon verb: `selectAccount` points the conversation, then the press resumes the held turn
// under the new credential. `carry` keeps the provider session (re-reads once, cold); fresh reseeds from the
// record (a short hand-off, and anything not recorded is lost).
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
        <!--
            A floor, not `min-w-0`: every other control is `shrink-0`, so without one the status text absorbs all
            overflow
            into wrapped words instead of the buttons dropping to their own row. This is a status now, so the floor
            fits one
            line of it rather than reading well.
        -->
        <span class="min-w-[11rem] flex-1">{{ status }}</span>
        <!--
            This ending's wait: one slot, four possible fillings, never two at once. The way out comes first when
            already
            armed, the way in otherwise.
        -->
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
        <!--
            The words say what the press does ("this chat", "keep going"), not the setting's name — naming the blast
            radius
            up front rather than in a parenthesis nobody reads.
        -->
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
        <!--
            The allowance's own pair, same slot and order; named as an appointment (fires once, at the published hour)
            rather than a retry.
        -->
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
        <!--
            The press and its variants: the reset when offered, Continue, inline Auto-continue in the two-action case,
            or a
            caret menu otherwise.
        -->
        <div ref="waysAnchor" class="flex shrink-0 items-center gap-1">
            <!--
                What the press spends, said on the control that spends it: a once-a-week grant, worth telling the user
                about
                before it's gone. The weekly allowance stays untouched, which is why this is worth pressing while it
                still has
                room.
            -->
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
        <!--
            What came back when the reset changed nothing, on its own line (`basis-full`, not a row slot): these are
            full
            sentences, and inline they push the status past its floor and wrap. Sits below the controls, in reading
            order,
            since it reports what just happened.
        -->
        <span v-if="resetNote !== undefined" class="basis-full text-2xs text-subtle">{{ resetNote }}</span>
    </div>
    <!-- The press's variants, shown in the dropdown when more than one alternative way on exists. -->
    <ResponsiveOverlay v-model="waysOpen" :anchor="waysAnchor" cross="end" header="Other ways on" panel-class="w-80 p-1">
        <div class="flex flex-col p-1">
            <!--
                The other account, twice when the session is worth carrying: same press, two prices, so the reader
                picks
                between fidelity and tokens rather than two look-alike buttons.
            -->
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
    <!--
        What an armed chat looks like while it waits on itself; stays on screen for as long as the automation runs,
        since a switch with no off is a trap.
    -->
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

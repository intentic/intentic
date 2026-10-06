<script setup lang="ts">
import { isTurnBreak, type TurnBreakPolicy } from "@intentic/sandbox-contract";
import { Button, formatTokens, Icon, type IconName, ResponsiveOverlay, SegmentedControl, type Tip, type TooltipValue, useDevice } from "@intentic/ui";
import { messageOr, useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useAgents } from "../../agents/fleet/useAgents";
import SandboxOutdatedNotice from "../../sandbox/overview/version/SandboxOutdatedNotice.vue";
import { accountsOutdated } from "../accounts/accountsOutdated";
import { modelLabelFor, modelOptionsFor } from "../accounts/providerCatalog";
import { fallbackAccount, fallbackLabel } from "../session/limitFallback";
import { askLimitReset, claimLimitReset, limitResetFor, limitResetNote } from "../session/limitReset";
import { pickUpNext, pickUpStatus, pressCost } from "../run/pickUp";
import { breakAnswers, effectivePolicy, sandboxPolicy } from "../run/turnBreak";
import { usePaneView } from "./useChat-view";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// One card for every ending that leaves work behind a live session (a dead turn, an outage, a spent allowance), and it
// asks exactly one question: what happens next. Three lines, in the order a reader needs them — what happened, what
// will happen and when, and the press that skips the waiting.
//
// The answers are mutually exclusive on purpose. Before this, four independent switches could be armed at once over
// the same event, each with its own off button and its own clock, and a chat could show two cards counting down to the
// same instant in two different formats. One question with one answer cannot do that.

const t = useT();

const props = defineProps<{
    /** The pane's reading of the pick-up: whether to say anything, and whether a press would get through now. */
    visible: boolean;
    ready: boolean;
}>();
// The press, and whether it keeps the provider session across an account change (the menu's carrying variant).
const emit = defineEmits<{ (event: "continue", options?: { readonly carry?: boolean }): void }>();

const { conversation, connected, pickUp, provider, model, account, accounts, selectModel } = usePaneView();
const { reachable } = useSandbox();
const { settings } = useSandboxSettings();
const { mobile } = useDevice();
const { agentById, setBreakPolicy } = useAgents();

// The clock runs only while something on screen counts down: a reset, a breaker's next try, a booked rung.
const counting = computed(() => props.visible && pickUp.value !== undefined && (pickUp.value.readyAt !== undefined || pickUp.value.nextAt !== undefined));
const now = useNow(() => counting.value);

const ending = computed(() => pickUp.value?.reason);
const status = computed(() => (pickUp.value === undefined ? `` : pickUpStatus(pickUp.value, now.value)));

// A held turn resends unchanged: nothing is added to the conversation, so pressing it twice is free. The reset
// shown is the provider's own guess and is routinely early; pressing before it costs one refused request.
// Press cost, shown to un-hide it: a held turn that ran re-reads its whole context cold; one refused at the door
// opens a fresh session with a short hand-off (both measured by the daemon at failure, PickUp.held).
const continueHint = computed((): TooltipValue => {
    const keys = !mobile.value && props.ready ? t(`ui.keys.enter`) : undefined;
    if (pickUp.value?.held !== undefined) {
        const cost = pressCost(pickUp.value.held);
        return {
            title: t(`chat.chatContinueStrip.resendUnchanged`),
            keys,
            rows:
                cost === undefined
                    ? []
                    : [
                          {
                              label: cost.kind === `reread` ? t(`chat.chatContinueStrip.rereads`) : t(`chat.chatContinueStrip.handoff`),
                              value: t(`chat.chatContinueStrip.aboutTokens`, { tokens: formatTokens(cost.tokens) }),
                          },
                      ],
            note: t(`chat.chatContinueStrip.mayBeatReset`),
        };
    }
    if (!props.ready) {
        return t(`chat.chatContinueStrip.awaitingReset`);
    }
    return { title: t(`chat.chatContinueStrip.pickUp`), keys };
});

// The provider's safety classifier stopped the turn. No standing answer: each time, the person sends it again on this
// model (the daemon cuts the stopped response out of the session first) or picks another, which the conversation then
// stays on, as a pick in the picker would.
const flagged = computed(() => ending.value === `flagged`);
const modelLabel = computed(() => modelLabelFor(provider.value, model.value));
const otherModels = computed(() =>
    flagged.value ? modelOptionsFor(provider.value).filter((option) => option.value !== model.value && option.helperOnly === undefined) : [],
);
const continueKeys = computed(() => (!mobile.value && props.ready ? t(`ui.keys.enter`) : undefined));
const retryHint = computed((): Tip => ({ title: t(`chat.chatContinueStrip.retryTitle`), keys: continueKeys.value, note: t(`chat.chatContinueStrip.retryNote`) }));
const otherModelHint = computed((): Tip => ({ title: t(`chat.chatContinueStrip.otherModelTitle`), note: t(`chat.chatContinueStrip.otherModelNote`) }));
const modelsOpen = ref(false);
const modelsAnchor = ref<HTMLElement>();
watch(
    () => props.visible && flagged.value,
    (open) => {
        if (!open) {
            modelsOpen.value = false;
        }
    },
);
const continueOnModel = (value: string): void => {
    modelsOpen.value = false;
    if (!reachable.value) {
        return;
    }
    selectModel({ provider: provider.value, value });
    emit(`continue`);
};

// What the reset press spends: a once-a-week grant, said before it is gone.
const resetTip = computed(
    (): Tip => ({
        title: t(`chat.chatContinueStrip.resetTitle`),
        rows: [{ label: t(`chat.chatContinueStrip.resetSpends`), value: t(`chat.chatContinueStrip.oneWeeklyReset`) }],
        note: t(`chat.chatContinueStrip.weeklyUntouched`),
    }),
);

// The way on that skips waiting entirely: read off the reason since this needs only another pool with room.
// limitFallback.ts judges which account may be offered, and the same reading names the `move` answer below. A sandbox too
// old to move a conversation (accountsOutdated) is offered none: the card says it needs an update instead.
const fallback = computed(() =>
    ending.value !== `limit` || accountsOutdated.value
        ? undefined
        : fallbackAccount(provider.value, account.value, accounts.value, model.value === `` ? undefined : { id: model.value }),
);
// Said only where another account is connected, the one case the move would have been offered.
const outdated = computed(() => ending.value === `limit` && accountsOutdated.value && accounts.value.length > 1);

// The one question, and this conversation's current answer to it. Read through the same fold every other surface uses
// (this agent's override, else the sandbox-wide policy), so the card, the settings row and this control cannot
// disagree about what is armed.
const answers = computed(() =>
    ending.value === undefined || !isTurnBreak(ending.value)
        ? []
        : breakAnswers(ending.value, fallback.value === undefined ? undefined : fallbackLabel(fallback.value)),
);
// Each pill's hover: its own name and the one consequence that tells it from the others.
const answerOptions = computed(() =>
    answers.value.map((answer) => ({ label: answer.label, value: answer.value, icon: answer.icon, title: { title: answer.label, note: answer.brief } })),
);

// Held while a write is in flight, so the pill moves under the finger rather than after the round trip; cleared either
// way, so a refused write snaps back to what the daemon actually holds.
const pending = ref<TurnBreakPolicy>();
// Why the last answer didn't save; about that question only, so a new ending starts without it.
const answerRefused = ref<string>();
watch(ending, () => {
    answerRefused.value = undefined;
});
const answer = computed<TurnBreakPolicy>({
    get: () =>
        pending.value ??
        (ending.value === undefined || !isTurnBreak(ending.value)
            ? `wait`
            : effectivePolicy(ending.value, agentById(conversation.value.conversationId), settings.value)),
    set: (next) => void choose(next),
});
const choose = async (next: TurnBreakPolicy): Promise<void> => {
    const wall = ending.value;
    if (wall === undefined || !isTurnBreak(wall) || !reachable.value) {
        return;
    }
    pending.value = next;
    answerRefused.value = undefined;
    try {
        // Writing the sandbox's own answer clears the override instead of freezing a copy of a default this
        // conversation would then quietly stop following.
        await setBreakPolicy(conversation.value.conversationId, wall, next === sandboxPolicy(wall, settings.value) ? null : next);
        // The outage is the one ending with a second party already retrying it: this window has to start (or stop)
        // watching for the run the daemon brings back, or a resumed turn streams into nothing.
        conversation.value.failures.watchOutage(next === `retry`);
        // The daemon books a move only as a refusal lands, so choosing it afterwards would otherwise just leave the turn
        // waiting for the reset under a pill that says "Move": the answer promises a move at once, so this one moves now,
        // keeping the session by the daemon's own rule (sibling-account.ts bookLimitMove).
        if (next === `move` && wall === `limit` && fallback.value !== undefined && pickUp.value?.held?.moving === undefined) {
            void continueOnFallback(carriesOnMove.value);
        }
    } catch (error) {
        // Left as it stands: a control that moved on a failed write would claim an automation nobody armed. The snap
        // back alone is easy to miss, so the card says why.
        answerRefused.value = messageOr(error, t(`chat.chatContinueStrip.answerNotSaved`));
    } finally {
        pending.value = undefined;
    }
};

// What that answer will actually do, and when. Absent while the answer is `wait`, where the selected pill has already
// said it and a line repeating it is the second strip all over again.
const nextLine = computed(() => (pickUp.value === undefined ? undefined : pickUpNext(pickUp.value, answer.value, now.value)));

// The only control here that changes whether a press can work, rather than when: reopens the account's five-hour
// window on demand (once a week), leaving the weekly pool alone. Asked about the conversation's own account pick
// when it has one, since the chat may have been re-pointed since the refusal; limitReset.ts holds the mechanism.
const limitAccount = computed(() =>
    ending.value !== `limit` ? undefined : (account.value ?? agentById(conversation.value.conversationId)?.account),
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

// The caret holds press VARIANTS only, never an automation: those are answers to the question above, and a way to arm
// one from two places is how the surfaces drifted apart before. Two rows at most, and only when a sibling account with
// room exists.
const waysOpen = ref(false);
const waysAnchor = ref<HTMLElement>();
const hasMenu = computed(() => fallback.value !== undefined);
// An emptied menu also closes it: an empty strip shouldn't leave a floating panel behind.
watch(
    () => props.visible && hasMenu.value,
    (open) => {
        if (!open) {
            waysOpen.value = false;
        }
    },
);

// One daemon command (switchAccount) moves the conversation and re-runs the held turn on the new credential. `carry`
// keeps the provider session (re-reads once, cold); fresh reseeds from the record (a short hand-off, and anything not
// recorded is lost). Where no held turn is this sandbox's to move (nothing held, another box), the pick then the press.
const continueOnFallback = async (carry: boolean): Promise<void> => {
    const target = fallback.value;
    if (target === undefined || !reachable.value) {
        return;
    }
    waysOpen.value = false;
    if (await conversation.value.turn.continueOn(target.id, carry)) {
        return;
    }
    conversation.value.selection.apply({ kind: `selectAccount`, account: target.id });
    emit(`continue`, { carry });
};
const canCarry = computed(() => pickUp.value?.held?.ran === true);
// What the `move` answer carries when chosen on a held turn: the same line the daemon draws when it books the move itself.
const carriesOnMove = computed(() => {
    const tokens = pickUp.value?.held?.contextTokens;
    return canCarry.value && tokens !== undefined && tokens < (settings.value?.limitMoveCarryUnder ?? 100_000);
});
const carryLine = computed(() => {
    const tokens = pickUp.value?.held?.contextTokens;
    return tokens === undefined
        ? t(`chat.chatContinueStrip.keepsSessionUnmeasured`)
        : t(`chat.chatContinueStrip.keepsSessionRereading`, { tokens: formatTokens(tokens) });
});
const freshLine = computed(() => {
    const tokens = pickUp.value?.held?.handoffTokens;
    return tokens === undefined
        ? t(`chat.chatContinueStrip.freshSessionShortHandoff`)
        : t(`chat.chatContinueStrip.freshSessionSizedHandoff`, { tokens: formatTokens(tokens) });
});

// The menu's rows, in the order they are offered: the other account twice when the session is worth carrying — one
// press, two prices.
const waysRows = computed((): readonly { key: string; icon: IconName; title: string; note: string; press: () => void }[] => {
    const target = fallback.value;
    if (target === undefined) {
        return [];
    }
    return [
        ...(canCarry.value
            ? [
                  {
                      key: `carry`,
                      icon: `user` as IconName,
                      title: t(`chat.chatContinueStrip.continueOnKeepingSession`, { fallback: fallbackLabel(target) }),
                      note: carryLine.value,
                      press: () => void continueOnFallback(true),
                  },
              ]
            : []),
        {
            key: `fresh`,
            icon: `user` as IconName,
            title: canCarry.value
                ? t(`chat.chatContinueStrip.continueOnFresh`, { model: fallbackLabel(target) })
                : t(`chat.chatContinueStrip.continueOn`, { model: fallbackLabel(target) }),
            note: freshLine.value,
            press: () => void continueOnFallback(false),
        },
    ];
});
</script>

<template>
    <div v-if="visible" class="flex flex-col gap-1.5 rounded-xl bg-card shadow-sm px-3 py-2 text-2xs text-muted">
        <!-- What happened, and the press that skips whatever is booked below. -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Icon :name="ready ? `pause` : `clock`" class="shrink-0" />
            <!-- Status text has a minimum width beside shrinkable controls. -->
            <span class="min-w-[11rem] flex-1">{{ status }}</span>
            <div ref="waysAnchor" class="flex shrink-0 items-center gap-1">
                <!-- What the press spends, said on the control that spends it: a once-a-week grant, worth telling the user about before it's gone. -->
                <Button
                    v-if="canReset"
                    size="small"
                    severity="secondary"
                    :text="true"
                    :disabled="!reachable || resetting"
                    v-tooltip.top="resetTip"
                    @click="useLimitReset"
                >
                    <Icon name="refresh" class="mr-1 text-2xs" />{{
                        resetting ? t(`chat.chatContinueStrip.resetting`) : t(`chat.chatContinueStrip.resetLimitNow`)
                    }}
                </Button>
                <!-- A flagged turn's two ways on, both a press: the same model again, or another one picked here. -->
                <template v-if="flagged">
                    <span ref="modelsAnchor" class="flex">
                        <Button
                            v-if="otherModels.length > 0"
                            size="small"
                            severity="secondary"
                            :disabled="!reachable || !ready"
                            :aria-expanded="modelsOpen"
                            v-tooltip.top="otherModelHint"
                            @click="modelsOpen = !modelsOpen"
                        >
                            {{ t(`chat.chatContinueStrip.continueOnOther`) }}<Icon name="chevron-down" class="ml-1 text-2xs" />
                        </Button>
                    </span>
                    <Button size="small" :disabled="!reachable || !ready" v-tooltip.top="retryHint" @click="emit(`continue`)">
                        {{ t(`chat.chatContinueStrip.retryOn`, { model: modelLabel }) }}
                    </Button>
                </template>
                <!-- The card's one solid press: every other control here decides WHEN, this one does it now. -->
                <Button v-else size="small" :disabled="!reachable || !ready" v-tooltip.top="continueHint" @click="emit(`continue`)">
                    {{ t(`ui.action.continue`) }}
                </Button>
                <Button
                    v-if="hasMenu"
                    size="small"
                    severity="secondary"
                    :text="true"
                    :disabled="!reachable"
                    :aria-label="t(`chat.chatContinueStrip.otherWaysOn`)"
                    :aria-expanded="waysOpen"
                    v-tooltip.top="t(`chat.chatContinueStrip.otherAccounts`)"
                    @click="waysOpen = !waysOpen"
                >
                    <Icon name="chevron-down" class="text-2xs" />
                </Button>
            </div>
        </div>
        <!-- The one question. Exactly one answer is selected, so nothing on this card can promise two automations. -->
        <div v-if="answerOptions.length > 1" class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="shrink-0 text-subtle">{{ t(`chat.turnBreak.next`) }}</span>
            <SegmentedControl
                v-model="answer"
                :options="answerOptions"
                size="xs"
                :wrap="true"
                :aria-label="t(`chat.turnBreak.nextQuestion`)"
                class="shrink-0"
                :class="{ 'pointer-events-none opacity-60': !reachable || !connected }"
            />
            <!-- What that answer does, and when: one clock, stated once, on the line the answer sits on. -->
            <span v-if="nextLine !== undefined" class="min-w-0 flex-1 text-subtle">{{ nextLine }}</span>
        </div>
        <span v-if="answerRefused !== undefined" role="alert" class="text-2xs text-danger">{{ answerRefused }}</span>
        <!-- What came back when the reset changed nothing: these are full sentences, so they get their own line. -->
        <span v-if="resetNote !== undefined" class="text-2xs text-subtle">{{ resetNote }}</span>
        <!-- A sandbox too old to move a conversation: no other account is offered, and this says why and how to update. -->
        <SandboxOutdatedNotice v-if="outdated" :missing="t(`chat.chatContinueStrip.outdatedMissing`)" />
    </div>
    <!-- The models a flagged turn can go on with: picking one switches the conversation to it and sends the turn again. -->
    <ResponsiveOverlay
        v-model="modelsOpen"
        :anchor="modelsAnchor"
        cross="end"
        :header="t(`chat.chatContinueStrip.continueOnOther`)"
        panel-class="w-72 p-1"
    >
        <div class="flex max-h-80 flex-col overflow-y-auto p-1">
            <button
                v-for="option in otherModels"
                :key="option.value"
                type="button"
                class="ui-row-select flex flex-col rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="continueOnModel(option.value)"
            >
                <span class="truncate text-sm text-content md:text-xs">{{ option.label }}</span>
                <span v-if="option.description !== undefined" class="truncate text-2xs text-subtle">{{ option.description }}</span>
            </button>
        </div>
    </ResponsiveOverlay>
    <!-- The press's variants, shown in the dropdown when another account could take this turn. -->
    <ResponsiveOverlay v-model="waysOpen" :anchor="waysAnchor" cross="end" :header="t(`chat.chatContinueStrip.otherWaysOn`)" panel-class="w-80 p-1">
        <div class="flex flex-col p-1">
            <button
                v-for="way in waysRows"
                :key="way.key"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="way.press"
            >
                <Icon :name="way.icon" class="mt-0.5 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-sm text-content md:text-xs">{{ way.title }}</span>
                    <span class="text-2xs text-subtle">{{ way.note }}</span>
                </span>
            </button>
        </div>
    </ResponsiveOverlay>
</template>

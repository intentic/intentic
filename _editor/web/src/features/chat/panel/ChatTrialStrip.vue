<script setup lang="ts">
import { Button, Icon, Meter, toneWash } from "@intentic/ui";
import { formatUntil } from "@intentic/ui/time";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { isTrialProvider, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { trialExhausted, trialPhase } from "../session/access";
import { modelLabelFor, trialStatus } from "../accounts/providerCatalog";
import { loadTrialStatus } from "../models/useChat-catalog";
import { usePaneView } from "./useChat-view";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useT } from "@intentic/ui/i18n";
import { MODELS_PATH } from "../../../lib/routes/modelsPath";

// The free trial's standing above the composer, as one short card rather than a paragraph: a headline that is the
// news (what is left, or that nothing is), one quiet line of facts under it, and the press that ends the trial. The
// picker says all of it once at the moment of choosing; this is what stays in view while the allowance runs down.

const t = useT();

const { conversation, provider, streaming } = usePaneView();
const { reachable } = useSandbox();

// Not answering is an interruption; working for it is not — conflating the two put "Failed messages are not
// counted" over answers that had just worked. `unavailable` means no key answered (the turn is held and refunded,
// Retry is real); `degraded` means the pool answered after failing over, the ladder working as designed.
type TrialCard = {
    readonly state: `left` | `spent` | `unavailable`;
    readonly title: string;
    // The quiet line under the headline, each fact its own phrase so they wrap as units, never mid-thought.
    readonly facts: readonly string[];
    // Said first and in the warning ink: it explains a slower or weaker answer the reader is watching right now.
    readonly strained: boolean;
    // What is left of the day's allowance, as a bar that empties the way the headline counts down. Only while some is
    // left; spent says it in words.
    readonly left: number | undefined;
};

const card = computed<TrialCard | undefined>(() => {
    if (!isTrialProvider(provider.value)) {
        return undefined;
    }
    const status = trialStatus.value;
    // Spent is this strip's alone to say: the account gate would otherwise report the trial as "not connected", which
    // is false and contradicts the line under it. Names no single vendor: free-and-uncapped is a Google sign-in, a
    // model on this machine, or a subscription the reader may already hold, and the view offering all three is the press.
    if (trialExhausted(provider.value)) {
        const resets = status.resetsAt === undefined ? Number.NaN : Date.parse(status.resetsAt);
        return {
            state: `spent`,
            title: t(`chat.chatPaneNotices.trialSpent`),
            facts: [
                ...(Number.isNaN(resets) ? [] : [t(`chat.chatPaneNotices.trialResets`, { when: formatUntil(resets) })]),
                t(`chat.chatPaneNotices.trialFreeWays`),
            ],
            strained: false,
            left: undefined,
        };
    }
    if (status.health === `unavailable`) {
        return {
            state: `unavailable`,
            title: t(`chat.chatPaneNotices.trialUnavailable`),
            facts: [t(`chat.chatPaneNotices.trialNotCounted`)],
            strained: false,
            left: undefined,
        };
    }
    const strained = status.health === `degraded`;
    // Not a warning until it is one: shown once the trial is past fresh (trialPhase) or the pool is straining, not from
    // the first message, since a fresh count read as an imminent limit.
    if (trialPhase(provider.value) === `fresh` && !strained) {
        return undefined;
    }
    // Which model answered: the trial serves a different real model per message (trial-ladder.ts), so this is the only
    // way to tell a weak answer from a fallback rung. Said here only while the pool strains, which is when the ladder
    // falls; otherwise it is the model pill's to say, under the pointer, as it is for any other model.
    const served =
        strained && status.servedModel !== undefined
            ? [t(`chat.chatPaneNotices.trialLastAnswer`, { model: modelLabelFor(TRIAL_PROVIDER, status.servedModel) })]
            : [];
    return {
        state: `left`,
        title: t(`chat.chatPaneNotices.trialCount`, { remaining: status.remaining, allowance: status.allowance }),
        // It counts model calls, not turns, so one turn can spend several; and every trial message is routed through
        // intentic's own servers, which every surface offering the trial must say (agent-catalog.ts).
        facts: [...served, t(`chat.chatPaneNotices.trialStepCost`), t(`chat.chatPaneNotices.trialRouted`)],
        strained,
        left: status.allowance > 0 ? status.remaining / status.allowance : undefined,
    };
});

// The bar turns amber for the last fifth: the point where "connect something" stops being advice.
const meterTone = computed(() => (card.value?.left !== undefined && card.value.left <= 0.2 ? `warning` : `accent`));
// The tile carries the state at a glance: the trial's own gift while it works, the warning ink once it doesn't.
const tile = computed(() =>
    card.value?.state === `left`
        ? { icon: `gift` as const, tone: `primary` as const }
        : { icon: card.value?.state === `spent` ? (`clock` as const) : (`exclamation-triangle` as const), tone: `warning` as const },
);

const retryTrial = async (): Promise<void> => {
    if (!reachable.value) {
        return;
    }
    await loadTrialStatus();
    await conversation.value.turn.resume();
};
</script>

<template>
    <!-- A status, not an alert: it changes as the reader works, and a screen reader should not be interrupted by it. -->
    <div v-if="card" class="flex items-start gap-3 rounded-xl bg-card px-3 py-2.5 text-left text-2xs shadow-sm" role="status">
        <span class="flex size-7 shrink-0 items-center justify-center rounded-lg" :class="toneWash(tile.tone)" aria-hidden="true">
            <Icon :name="tile.icon" class="text-xs" />
        </span>
        <!-- The words and the presses wrap inside one column, so a press that drops under the words in a narrow pane
             lines up with them rather than with the tile. -->
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
            <!-- A floor, not `min-w-0` (ChatContinueStrip's own lesson): the presses beside it are `shrink-0`, and without
                 one the text squeezed to a word a line before the row would wrap. -->
            <div class="min-w-[12rem] flex-1">
                <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span class="font-medium text-content">{{ card.title }}</span>
                    <!-- Repeats the headline's figure, so it hides from a screen reader rather than say it twice. -->
                    <Meter v-if="card.left !== undefined" :value="card.left" :tone="meterTone" class="w-16" />
                </div>
                <p class="mt-0.5 text-subtle">
                    <span v-if="card.strained" class="text-warning">{{ t(`chat.chatPaneNotices.trialStrained`) }}</span>
                    <template v-for="(fact, index) in card.facts" :key="fact">
                        <span v-if="index > 0 || card.strained" aria-hidden="true"> · </span>
                        <span class="whitespace-nowrap">{{ fact }}</span>
                    </template>
                </p>
            </div>
            <!-- Notice actions share one button style and baseline. -->
            <div class="flex max-w-full shrink-0 flex-wrap items-center gap-1">
                <Button
                    v-if="card.state === `unavailable`"
                    size="small"
                    thumb
                    :disabled="!reachable || streaming"
                    v-tooltip.top="{ title: t(`chat.chatPaneNotices.retryTrial`), note: t(`chat.chatPaneNotices.resumesIfAnswers`) }"
                    @click="retryTrial"
                >
                    <Icon name="refresh" class="mr-1 text-2xs" />{{ t(`ui.action.retry`) }}
                </Button>
                <!-- One action, not two: the spent trial's question is "what now", and the model list was the same answer
                     arrived at sideways. Standing whenever this card does, not only once spent — somebody halfway through the
                     day's allowance who wants to connect now should not have to run out first. The card's one filled press,
                     except beside Retry, which is the thing to try first there. A place, so a link drawn as a button:
                     Ctrl/Cmd-click keeps this conversation. -->
                <Button
                    :as="RouterLink"
                    :to="MODELS_PATH"
                    size="small"
                    thumb
                    :tier="card.state === `unavailable` ? `boring` : `accent`"
                    v-tooltip.top="{ title: t(`chat.chatPaneNotices.connectTitle`), note: t(`chat.chatPaneNotices.connectWays`) }"
                >
                    {{ t(`chat.words.connectAModel`) }}<Icon name="arrow-right" class="ml-1.5 text-2xs" />
                </Button>
            </div>
        </div>
    </div>
</template>

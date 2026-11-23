<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import type { IconName } from "@intentic/ui";
import { Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { toneWash } from "@intentic/ui/tone";
import { computed, nextTick, ref, useId, useTemplateRef } from "vue";
import type { SignInFailureKind } from "../../../models/conversations/run/signInOutcome";
import ConnectFlow from "../secrets/ConnectFlow.vue";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import { elapsedWords, overdue } from "../../../components/progress/progress";
import { useBusySince, useProgress } from "../../../components/progress/useProgress";
import ConnectSteps from "./ConnectSteps.vue";
import HeightGlide from "./HeightGlide.vue";
import SignInRing from "../secrets/SignInRing.vue";

// A provider's sign-in, inside its own panel in Sandbox ▸ Models, under the accounts it is adding to. Not a card of its
// own: it is a step of the panel it sits in, and a card inside that card read as a second, unrelated thing. A reader sent
// back by the chat's "Finish sign-in" lands on the panel it belongs to, which the page opens for them.
//
// Three phases: starting (the press is on its way to the sandbox), live (the reader's turn, ConnectFlow), and failed (it
// ended without connecting anything, said with why and the fix that matches). Every phase sits under the same three
// steps (ConnectSteps: Open, Sign in, Connect), and the block between phases and steps eases to its new height
// (HeightGlide) while the new content rises in, so the attempt reads as one thing moving forward.

const t = useT();

const {
    provider,
    phase,
    kind = `native`,
    problem,
    failure = `refused`,
    finishing = false,
} = defineProps<{
    provider: AgentProvider;
    phase: `starting` | `live` | `failed`;
    // Which mechanism holds a live sign-in; ConnectFlow reads the matching handshake.
    kind?: `native` | `routed`;
    // Live: a sentence about the step just tried (a pasted address that was refused). Failed: why it ended.
    problem?: string | undefined;
    // Failed: how it ended, which picks the card's title, glyph and words (signInOutcome.ts).
    failure?: SignInFailureKind | undefined;
    // What was brought back is being redeemed: there is nothing left to cancel.
    finishing?: boolean;
}>();
const emit = defineEmits<{ cancel: []; retry: []; dismiss: [] }>();

const name = computed(() => providerSpec(provider)?.accountLabel ?? provider);
const destination = computed(() => providerSpec(provider)?.destination ?? name.value);
const heading = computed(() =>
    phase === `failed`
        ? t(`connect.connectAttempt.didntConnect`, { provider: name.value })
        : t(`connect.connect.connecting`, { provider: name.value }),
);

// Which of the three steps is under way: the live panel says for its own steps; before it there is only going, and a
// failure stops at the step it happened on (one that never started, at the first).
const liveStage = ref<0 | 1 | 2>(0);
const stage = computed<0 | 1 | 2>(() => {
    if (phase === `starting`) {
        return 0;
    }
    if (phase === `failed`) {
        return failure === `unstarted` ? 0 : 1;
    }
    return liveStage.value;
});

// What a failed attempt says, by how it ended: a timeout is the reader's to restart and says so in the app's words; a
// start the sandbox never produced, or a sign-in turned down, carries the sandbox's or the provider's own sentence.
const FAILED = {
    expired: { icon: `clock`, tone: `warning` },
    unstarted: { icon: `plug`, tone: `danger` },
    refused: { icon: `exclamation`, tone: `danger` },
} as const satisfies Record<SignInFailureKind, { icon: IconName; tone: `warning` | `danger` }>;
const failedTitle = computed(() =>
    failure === `expired`
        ? t(`connect.connectAttempt.expiredTitle`)
        : failure === `unstarted`
          ? t(`connect.connectAttempt.unstartedTitle`)
          : t(`connect.connectAttempt.refusedTitle`, { destination: destination.value }),
);
const failedDetail = computed(() => (failure === `expired` ? t(`connect.connectAttempt.expiredDetail`) : problem));

// How long the press has been on its way to the sandbox, on the same line as the spinner: a sandbox that is busy or still
// waking answers late, and a line that never changed read as a press that went nowhere.
const startWait = useProgress(
    useBusySince(() => phase === `starting`),
    { expectedMs: 8_000 },
);
const startElapsed = computed(() => elapsedWords(startWait.value));
const startSlow = computed(() => startWait.value !== undefined && overdue(startWait.value));

const headingId = useId();
const block = useTemplateRef<HTMLElement>(`block`);
const headingEl = useTemplateRef<HTMLElement>(`headingEl`);

// Brought into view and given focus when a press started it: on a short window the panel's button may sit above the
// fold of what it opens, and a sign-in that opened out of sight read as a press that did nothing.
const reveal = async (): Promise<void> => {
    await nextTick();
    headingEl.value?.focus({ preventScroll: true });
    block.value?.scrollIntoView?.({ block: `nearest` });
};
defineExpose({ reveal });
</script>

<template>
    <section ref="block" class="ui-enter flex flex-col gap-4" :aria-labelledby="headingId">
        <!-- One row for every phase: what is happening, then what ends or retries it, at the right. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h3
                :id="headingId"
                ref="headingEl"
                tabindex="-1"
                class="mr-auto flex min-w-0 items-center gap-2 text-sm font-medium leading-tight outline-none"
                :class="phase === `failed` ? `text-danger` : `text-content`"
            >
                <ProviderLogo :provider="provider" class="shrink-0" />{{ heading }}
            </h3>
            <template v-if="phase === `failed`">
                <Button size="small" tier="quiet" :label="t(`ui.action.dismiss`)" @click="emit(`dismiss`)" />
                <Button tier="accent" size="small" :label="t(`ui.action.tryAgain`)" @click="emit(`retry`)" />
            </template>
            <!-- Cancel sits with the heading, not inside the steps: it ends this whole attempt, whichever step it is on. -->
            <button
                v-else
                type="button"
                :disabled="finishing || phase === `starting`"
                :class="ui.textButton({ tone: `quiet` }, `shrink-0`)"
                @click="emit(`cancel`)"
            >
                {{ t(`ui.action.cancel`) }}
            </button>
        </div>

        <ConnectSteps :at="stage" :failed="phase === `failed`" />

        <HeightGlide>
            <div v-if="phase === `starting`" key="starting" class="ui-enter flex items-center gap-3" role="status">
                <!-- The provider's mark inside a turning ring: whose sign-in is being fetched, and that it is moving. -->
                <SignInRing motion="turn"><ProviderLogo :provider="provider" /></SignInRing>
                <div class="flex min-w-0 flex-col gap-0.5">
                    <p class="text-sm font-medium text-content">
                        {{ t(`connect.connectAttempt.opening`) }}
                        <span v-if="startElapsed" class="ml-1 text-xs font-normal tabular-nums text-subtle" aria-hidden="true">{{ startElapsed }}</span>
                    </p>
                    <p class="text-xs" :class="startSlow ? `text-warning` : `text-muted`">
                        {{ startSlow ? t(`connect.connectAttempt.openingSlow`) : t(`connect.connectAttempt.openingNext`, { provider: name }) }}
                    </p>
                </div>
            </div>

            <!-- How it ended, as a cause and the fix that matches it; the provider's own sentence below when it said one. -->
            <div v-else-if="phase === `failed`" key="failed" class="ui-enter flex items-start gap-3" role="alert">
                <span :class="toneWash(FAILED[failure].tone, `flex size-10 shrink-0 items-center justify-center rounded-full text-base`)">
                    <Icon :name="FAILED[failure].icon" />
                </span>
                <div class="flex min-w-0 flex-col gap-0.5 pt-0.5">
                    <p class="text-sm font-medium text-content">{{ failedTitle }}</p>
                    <p v-if="failedDetail" class="whitespace-pre-line break-words text-xs text-muted">{{ failedDetail }}</p>
                </div>
            </div>

            <!-- Choosing another provider over this one's sign-in ends this attempt, which puts the others back in front of the reader. -->
            <ConnectFlow
                v-else
                key="live"
                :kind="kind"
                :provider="provider"
                :problem="problem"
                @stage="(next) => (liveStage = next)"
                @elsewhere="emit(`cancel`)"
            />
        </HeightGlide>
    </section>
</template>

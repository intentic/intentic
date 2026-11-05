<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import { Button, Icon, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, useId, useTemplateRef } from "vue";
import ConnectFlow from "../secrets/ConnectFlow.vue";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import { elapsedWords, overdue } from "../../../components/progress/progress";
import { useBusySince, useProgress } from "../../../components/progress/useProgress";

// A provider's sign-in, inside its own panel in Sandbox ▸ Models, under the accounts it is adding to. Not a card of its
// own: it is a step of the panel it sits in, and a card inside that card read as a second, unrelated thing. A reader sent
// back by the chat's "Finish sign-in" lands on the panel it belongs to, which the page opens for them.
//
// Three phases: starting (the press is on its way to the sandbox), live (the reader's turn, ConnectFlow), and failed (it
// ended without connecting anything, said with why and a way to try again).

const t = useT();

const {
    provider,
    phase,
    kind = `native`,
    problem,
    finishing = false,
} = defineProps<{
    provider: AgentProvider;
    phase: `starting` | `live` | `failed`;
    // Which mechanism holds a live sign-in; ConnectFlow reads the matching handshake.
    kind?: `native` | `routed`;
    // Live: a sentence about the step just tried (a pasted address that was refused). Failed: why it ended.
    problem?: string;
    // What was brought back is being redeemed: there is nothing left to cancel.
    finishing?: boolean;
}>();
const emit = defineEmits<{ cancel: []; retry: []; dismiss: [] }>();

const name = computed(() => providerSpec(provider)?.accountLabel ?? provider);
const heading = computed(() =>
    phase === `failed`
        ? t(`connect.connectAttempt.didntConnect`, { provider: name.value })
        : t(`connect.connect.connecting`, { provider: name.value }),
);

// How long the press has been on its way to the sandbox, on the same line as the spinner: a sandbox that is busy or still
// waking answers late, and a line that never changed read as a press that went nowhere. Three stacked lines (heading,
// spinner sentence, a detached "4s so far") said nothing about what comes next; the wait is now one block: the provider's
// mark ringed by the spinner, what is happening with its time, and what the reader will do next (or, once it runs long,
// why it is slow).
const startWait = useProgress(
    useBusySince(() => phase === `starting`),
    { expectedMs: 8_000 },
);
const startElapsed = computed(() => elapsedWords(startWait.value));
const startSlow = computed(() => startWait.value !== undefined && overdue(startWait.value));

const headingId = useId();
// Where ConnectFlow puts the step's own button: in the heading's row, beside Cancel.
const actionsId = useId();
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
    <section ref="block" class="flex flex-col gap-1.5" :aria-labelledby="headingId">
        <!-- One row for every phase: what is happening, then what to press, at the right. The step's own action (Open, Open
             again) is sent up here by ConnectFlow, so a wide pane no longer stacks a button and three lines in its left third. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h3
                :id="headingId"
                ref="headingEl"
                tabindex="-1"
                class="mr-auto flex min-w-0 items-center gap-2 text-sm font-medium leading-tight outline-none"
                :class="phase === `failed` ? `text-danger` : `text-content`"
            >
                <Icon v-if="phase === `failed`" name="exclamation-circle" class="shrink-0" />{{ heading }}
            </h3>
            <div v-if="phase === `live`" :id="actionsId" class="flex items-center gap-2 empty:hidden"></div>
            <template v-else-if="phase === `failed`">
                <Button tier="accent" size="small" :label="t(`ui.action.tryAgain`)" @click="emit(`retry`)" />
                <Button size="small" tier="quiet" :label="t(`ui.action.dismiss`)" @click="emit(`dismiss`)" />
            </template>
            <!-- Cancel sits with the heading, not inside the steps: it ends this whole attempt, whichever step it is on. -->
            <button
                v-if="phase !== `failed`"
                type="button"
                :disabled="finishing || phase === `starting`"
                :class="ui.textButton({ tone: `quiet` }, `shrink-0`)"
                @click="emit(`cancel`)"
            >
                {{ t(`ui.action.cancel`) }}
            </button>
        </div>

        <div v-if="phase === `starting`" class="flex items-center gap-3 py-1" role="status">
            <!-- The provider's mark inside a turning ring: whose sign-in is being fetched, and that it is moving. -->
            <span class="relative flex size-9 shrink-0 items-center justify-center text-base text-content" aria-hidden="true">
                <span class="absolute inset-0 rounded-full border-2 border-line"></span>
                <span class="absolute inset-0 rounded-full border-2 border-transparent border-t-info motion-safe:animate-spin"></span>
                <ProviderLogo :provider="provider" />
            </span>
            <div class="flex min-w-0 flex-col gap-0.5">
                <p class="text-sm text-content">
                    {{ t(`connect.connectAttempt.opening`) }}
                    <span v-if="startElapsed" class="ml-1 text-xs tabular-nums text-subtle" aria-hidden="true">{{ startElapsed }}</span>
                </p>
                <p class="text-xs" :class="startSlow ? `text-warning` : `text-muted`">
                    {{ startSlow ? t(`connect.connectAttempt.openingSlow`) : t(`connect.connectAttempt.openingNext`, { provider: name }) }}
                </p>
            </div>
        </div>
        <p v-else-if="phase === `failed`" class="whitespace-pre-line break-words text-xs text-muted">{{ problem }}</p>
        <template v-else>
            <!-- A refused step stays beside the steps it refused, not in a banner over the page. -->
            <Notice v-if="problem" :of="{ tone: `danger`, title: problem }" size="sm" />
            <!-- Choosing another provider over this one's sign-in ends this attempt, which puts the others back in front of the reader. -->
            <ConnectFlow :kind="kind" :provider="provider" roomy :actions-target="actionsId" @elsewhere="emit(`cancel`)" />
        </template>
    </section>
</template>

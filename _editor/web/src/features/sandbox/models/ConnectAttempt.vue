<script setup lang="ts">
import { type AgentProvider, providerSpec } from "@intentic/sandbox-contract";
import { Button, Icon, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, useId, useTemplateRef } from "vue";
import ConnectFlow from "../secrets/ConnectFlow.vue";

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
    <section ref="block" class="flex flex-col gap-3" :aria-labelledby="headingId">
        <div class="flex items-start gap-2.5">
            <Icon
                :name="phase === `failed` ? `exclamation-circle` : phase === `starting` ? `spinner` : `sign-in`"
                :spin="phase === `starting`"
                class="mt-0.5 shrink-0"
                :class="phase === `failed` ? `text-danger` : `text-primary-500`"
            />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <h3 :id="headingId" ref="headingEl" tabindex="-1" class="text-sm font-medium leading-tight outline-none">{{ heading }}</h3>
                <p v-if="phase === `starting`" class="text-xs text-subtle" role="status">{{ t(`connect.connectAttempt.opening`) }}</p>
                <p v-else-if="phase === `failed`" class="whitespace-pre-line break-words text-xs text-muted">{{ problem }}</p>
            </div>
            <!-- Cancel sits with the heading, not inside the steps: it ends this whole attempt, whichever step it is on. -->
            <button
                v-if="phase !== `failed`"
                type="button"
                :disabled="finishing || phase === `starting`"
                :class="ui.textAction(`shrink-0 text-xs`)"
                @click="emit(`cancel`)"
            >
                {{ t(`ui.action.cancel`) }}
            </button>
        </div>

        <template v-if="phase === `live`">
            <!-- A refused step stays beside the steps it refused, not in a banner over the page. -->
            <Notice v-if="problem" :of="{ tone: `danger`, title: problem }" size="sm" />
            <ConnectFlow :kind="kind" :provider="provider" roomy />
        </template>

        <div v-else-if="phase === `failed`" class="flex flex-wrap items-center gap-2">
            <Button size="small" :label="t(`ui.action.tryAgain`)" @click="emit(`retry`)" />
            <Button size="small" severity="secondary" :text="true" :label="t(`ui.action.dismiss`)" @click="emit(`dismiss`)" />
        </div>
    </section>
</template>

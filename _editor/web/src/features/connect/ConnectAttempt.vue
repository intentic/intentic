<script setup lang="ts">
import { type AgentProvider, providerSpec } from "@intentic/sandbox-contract";
import { Button, Icon, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, useId, useTemplateRef } from "vue";
import ProviderLogo from "../chat/accounts/ProviderLogo.vue";
import { requirementWords } from "../chat/accounts/providerWords";
import ConnectFlow from "../sandbox/secrets/ConnectFlow.vue";

// The one sign-in on the connect view, wherever it was started: a tile in a lane, a row found on this computer, a link
// from the chat. It stands at the top of the page rather than inside the lane that started it, so a reader sent back
// by the chat's "Finish sign-in" lands on it whichever lane is open, and one who picks another provider below sees this
// card change to it instead of hunting for where the first one went.
//
// Three phases, one card: starting (the press is on its way to the sandbox), live (the reader's turn, ConnectFlow), and
// failed (it ended without connecting anything, said with why and a way to try again).

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

const spec = computed(() => providerSpec(provider));
const name = computed(() => spec.value?.accountLabel ?? provider);
// What the reader has to hold for this to work ("Kimi Code subscription", "Google sign-in"): the one fact worth a line
// under the name while the panel below says what to do.
const requirement = computed(() => (spec.value === undefined ? `` : requirementWords(spec.value.access, `name`)));
const heading = computed(() =>
    phase === `failed`
        ? t(`connect.connectAttempt.didntConnect`, { provider: name.value })
        : t(`connect.connect.connecting`, { provider: name.value }),
);

const headingId = useId();
const card = useTemplateRef<HTMLElement>(`card`);
const headingEl = useTemplateRef<HTMLElement>(`headingEl`);

// Brought into view and given focus when a press elsewhere on the page started it: the tile that was pressed may sit
// a screen below, and a sign-in that opened out of sight read as a press that did nothing.
const reveal = async (): Promise<void> => {
    await nextTick();
    headingEl.value?.focus({ preventScroll: true });
    card.value?.scrollIntoView?.({ block: `nearest` });
};
defineExpose({ reveal });
</script>

<template>
    <section
        ref="card"
        class="ui-card flex flex-col gap-4 p-4 sm:p-5"
        :class="phase === `failed` ? `border-danger/40` : `border-primary-500/40`"
        :aria-labelledby="headingId"
    >
        <div class="flex items-start gap-3">
            <span
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                :class="phase === `failed` ? `border-danger/40 bg-danger/10 text-danger` : `border-primary-500/40 bg-primary-500/10 text-primary-500`"
            >
                <Icon v-if="phase === `failed`" name="exclamation-circle" class="text-base" />
                <ProviderLogo v-else :provider="provider" class="text-base" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <h2 :id="headingId" ref="headingEl" tabindex="-1" class="font-medium leading-tight outline-none">{{ heading }}</h2>
                <p v-if="phase === `starting`" class="flex items-center gap-1.5 text-xs text-subtle" role="status">
                    <Icon name="spinner" spin />{{ t(`connect.connectAttempt.opening`) }}
                </p>
                <p v-else-if="phase === `failed`" class="whitespace-pre-line break-words text-xs text-muted">{{ problem }}</p>
                <p v-else-if="requirement" class="text-xs text-muted">{{ requirement }}</p>
            </div>
            <!-- Cancel sits with the name, not inside the steps: it ends this whole attempt, whichever step it is on. -->
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
            <p class="border-t border-line pt-3 text-2xs text-subtle">{{ t(`connect.connectAttempt.oneAtATime`) }}</p>
        </template>

        <div v-else-if="phase === `failed`" class="flex flex-wrap items-center gap-2">
            <Button size="small" :label="t(`ui.action.tryAgain`)" @click="emit(`retry`)" />
            <Button size="small" severity="secondary" :text="true" :label="t(`ui.action.dismiss`)" @click="emit(`dismiss`)" />
        </div>
    </section>
</template>

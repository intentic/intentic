<!-- Model pill (provider mark, name, chevron) that opens <ChatModelPicker>, shared by both composers. -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { isTrialProvider } from "@intentic/sandbox-contract";
import type { Conversation } from "../session/conversation";
import { trialBadge } from "../session/access";
import { modelLabelFor, newerVersionOf, trialStatus } from "../accounts/providerCatalog";
import { composerModelReading, stillRunningOn } from "./composerModelLabel";
import ProviderLogo from "../accounts/ProviderLogo.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const {
    conversation,
    expanded = false,
    disabled = false,
    labelClass = ``,
} = defineProps<{
    conversation: Conversation;
    /** Whether the picker this pill opens is showing: drives aria-expanded. */
    expanded?: boolean;
    /** Greyed and inert: the chat composer's controls go quiet under a workflow badge. */
    disabled?: boolean;
    /** Extra classes on the model name, for a composer that drops it in a narrow container. */
    labelClass?: string;
    /** Names the control; falls back to "Model: <name>". The chat composer names the provider too. */
    ariaLabel?: string;
}>();

const { provider, harness, model, auto } = conversation.selection;
// The whole face of the control (composerModelLabel.ts): the model, `Auto`, or the press to choose one when this
// chat has nothing that could answer.
const choice = computed(() => ({ provider: provider.value, harness: harness.value, model: model.value, auto: auto.value }));
const reading = computed(() => composerModelReading(choice.value));
const modelLabelText = computed(() => reading.value.label);
// A pick made while a reply runs is for the next message; the reply keeps the model it was sent under, so the pill says
// so rather than read as though the switch had reached it (a person asked the agent which model it was, twice).
const { streaming } = conversation.turn;
const runningOn = computed(() => stillRunningOn(choice.value, { streaming: streaming.value, sentModel: conversation.selection.state.value.sentModel }));
const nextHint = computed(() =>
    runningOn.value === undefined ? undefined : t(`chat.composerModelPill.fromNextMessage`, { model: modelLabelText.value, running: runningOn.value }),
);
// On the free trial the pill is where a reader goes to leave it, so it says so under the pointer: what is left today,
// which real model answered last (the trial picks one per message, trial-ladder.ts), and that this press is the way to
// another model or one of their own. Not over the press to choose one (spent), which already says it in its own words,
// and never over the running reply's own note.
const trialHint = computed(() => {
    const badge = reading.value.unset || !isTrialProvider(provider.value) ? undefined : trialBadge(provider.value);
    if (badge === undefined) {
        return undefined;
    }
    const served = trialStatus.value.servedModel;
    const lastAnswer = served === undefined ? [] : [t(`chat.composerModelPill.trialServed`, { model: modelLabelFor(provider.value, served) })];
    return { title: badge, note: [...lastAnswer, t(`chat.composerModelPill.trialNote`)].join(` `) };
});

// An older version of its family, said on the pill: "Opus 5" and "Opus 5.5" differ by two characters, and four chats in
// a row ran on the older one before anyone saw it. Silent on Auto (the model underneath is only its fallback) and on
// the press to choose one.
const newer = computed(() => (reading.value.unset || auto.value ? undefined : newerVersionOf(provider.value, model.value)));
const olderHint = computed(() =>
    newer.value === undefined
        ? undefined
        : {
              title: t(`chat.composerModelPill.olderTitle`, { newer: newer.value.label }),
              note: t(`chat.composerModelPill.olderNote`, { model: modelLabelText.value, newer: newer.value.label }),
              tone: `warning` as const,
          },
);

// The button itself: see the note above on why the anchor has to be this element and not a stand-in.
const el = ref<HTMLButtonElement>();
defineExpose({ el, label: modelLabelText });
</script>

<template>
    <button
        ref="el"
        type="button"
        class="composer-ghost h-8 min-w-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
        :disabled="disabled"
        :aria-expanded="expanded"
        :aria-label="ariaLabel ?? t(`chat.composerModelPill.model`, { modelLabelText })"
        :aria-description="nextHint ?? olderHint?.note"
        v-tooltip.top="nextHint ?? olderHint ?? trialHint"
    >
        <!-- A vendor's mark over a chat that vendor cannot answer is the same lie as its name; the list's own mark stands there. -->
        <Icon v-if="reading.unset" name="th-large" class="shrink-0 text-2xs text-link" aria-hidden="true" />
        <!-- Auto's own mark, so the armed state is legible with the label hidden on a narrow composer. -->
        <Icon v-else-if="auto" name="sparkles" class="shrink-0 text-2xs text-link" aria-hidden="true" />
        <ProviderLogo v-else :provider="provider" class="shrink-0 text-2xs text-link" />
        <span class="truncate" :class="labelClass">{{ modelLabelText }}</span>
        <!-- Hides with the name: on a pill down to its logo it would be the one word left. -->
        <span v-if="runningOn !== undefined" class="shrink-0 font-normal text-subtle" :class="labelClass">{{ t(`chat.composerModelPill.nextMessage`) }}</span>
        <span v-else-if="newer !== undefined" class="shrink-0 font-normal text-warning" :class="labelClass">{{ t(`chat.composerModelPill.older`) }}</span>
        <!-- Goes with the name: a pill down to its logo is a glyph press like its neighbours, and the chevron was width it no longer
             had. -->
        <Icon name="chevron-down" class="text-2xs text-subtle" :class="labelClass" />
    </button>
</template>

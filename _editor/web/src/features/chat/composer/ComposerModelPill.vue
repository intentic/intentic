<!-- Model pill (provider mark, name, chevron) that opens <ChatModelPicker>, shared by both composers. -->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { Conversation } from "../session/conversation";
import { composerModelReading } from "./composerModelLabel";
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

const { provider, harness, model, auto } = conversation;
// The whole face of the control (composerModelLabel.ts): the model, `Auto`, or the press to choose one when this
// chat has nothing that could answer.
const reading = computed(() => composerModelReading({ provider: provider.value, harness: harness.value, model: model.value, auto: auto.value }));
const modelLabelText = computed(() => reading.value.label);

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
    >
        <!-- A vendor's mark over a chat that vendor cannot answer is the same lie as its name; the list's own mark stands there. -->
        <Icon v-if="reading.unset" name="th-large" class="shrink-0 text-2xs text-link" aria-hidden="true" />
        <!-- Auto's own mark, so the armed state is legible with the label hidden on a narrow composer. -->
        <Icon v-else-if="auto" name="sparkles" class="shrink-0 text-2xs text-link" aria-hidden="true" />
        <ProviderLogo v-else :provider="provider" class="shrink-0 text-2xs text-link" />
        <span class="truncate" :class="labelClass">{{ modelLabelText }}</span>
        <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
    </button>
</template>

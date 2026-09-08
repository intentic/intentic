<!--
    Model pill (provider mark, name, chevron) that opens <ChatModelPicker>, shared by both composers. Exposes its button as `el`: AnchoredOverlay
    must anchor off the real element, not a copy, for a popped-out composer to keep working. No hover label; `aria-label` carries the full 'provider
    · model' pair.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { Conversation } from "../session/conversation";
import { modelLabelFor } from "../accounts/providerCatalog";
import ProviderLogo from "../accounts/ProviderLogo.vue";

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

const { provider, model } = conversation;
const modelLabelText = computed(() => modelLabelFor(provider.value, model.value));

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
        :aria-label="ariaLabel ?? `Model: ${modelLabelText}`"
    >
        <ProviderLogo :provider="provider" class="shrink-0 text-2xs text-link" />
        <span class="truncate" :class="labelClass">{{ modelLabelText }}</span>
        <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
    </button>
</template>

<!-- THE MODEL PILL: provider mark · model name · chevron, in the composer's ghost dress. Both composers (the
     chat's and the suggested-session box's) open the same ChatModelPicker off it, and both had written the
     button out by hand.

     IT EXPOSES ITS ELEMENT, and that is the whole reason this is a component with an `el` rather than a slot:
     the button IS the anchor. AnchoredOverlay derives from the anchor the document it teleports into, the
     viewport it measures the free room against, and the one click that must never dismiss the panel, so a
     popped-out composer works unchanged only if the overlay is handed THIS element rather than a remembered one.

     NO HOVER LABEL, deliberately: the old one said the provider's name, which the logo beside it is already
     there to say. The accessible name carries the full "provider · model" pair, which is what a screen reader
     needs and a sighted user can already read. -->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { Conversation } from "../composables/chat/conversation";
import { modelLabelFor } from "../composables/chat/providerCatalog";
import ProviderLogo from "./ProviderLogo.vue";

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

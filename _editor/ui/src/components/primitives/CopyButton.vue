<!--
    Copy-to-clipboard button with built-in "Copied" feedback. With `label`, a bordered chip; without one, a bare icon button (pass
    `aria-label`/`v-tooltip`). `stretch` and `severity` are separate questions: width and tone.
-->
<script setup lang="ts">
import Button from "./Button.vue";
import { computed, ref } from "vue";
import { clipboardOf } from "../../lib/clipboard.js";
import { vAction } from "../../lib/pressAction.js";
import { ui } from "../../lib/ui.js";

const {
    text,
    label = ``,
    cta = false,
    stretch = false,
} = defineProps<{
    // Clipboard payload: a string, or a resolver fetched on click (e.g. a secret we don't render just to copy it).
    text: string | (() => string | Promise<string>);
    // Visible text (e.g. "Copy"); omit for a bare icon-only button.
    label?: string;
    // Dress it as the action to take rather than a convenience, for the moment copying IS the next step.
    cta?: boolean;
    // Same meaning as SegmentedControl's `stretch`: full width and touch-sized, for a screen where copying
    // is the whole task. Implies `cta`.
    stretch?: boolean;
}>();

// Fired only on a write that actually landed, for a caller whose flow depends on the copy having happened.
const emit = defineEmits<{ copied: [] }>();

const copied = ref(false);
// The pressed element: a `<Button>` component for the emphasised spellings, a plain element for the
// quiet one, so `$el` is resolved either way.
const root = ref<HTMLButtonElement | { $el: HTMLElement }>();
const rootEl = (): HTMLElement | undefined => (root.value === undefined ? undefined : `$el` in root.value ? root.value.$el : root.value);

// Weight, not geometry: the quiet spelling stays a bare chip, since a copy-as-convenience is not an action.
const chrome = computed(() => (stretch ? `min-h-10 w-full gap-1.5 px-3 text-sm` : `gap-1.5`));

const copy = async (): Promise<void> => {
    try {
        // Chromium/Firefox allow awaiting a resolver before writeText; Safari's user-gesture rule may reject it.
        await clipboardOf(rootEl()).writeText(typeof text === `function` ? await text() : text);
        copied.value = true;
        emit(`copied`);
        setTimeout(() => (copied.value = false), 1500);
    } catch {
        // Clipboard unavailable (insecure context); the user can still select the text.
    }
};
</script>

<template>
    <Button v-if="label && (cta || stretch)" ref="root" size="small" :class="chrome" @click="copy">
        <Icon :name="copied ? 'check' : 'copy'" :class="[stretch ? `` : `text-2xs`, copied ? `text-success` : ``]" />
        {{ copied ? `Copied` : label }}
    </Button>
    <button v-else-if="label" ref="root" type="button" :class="ui.overlayChip()" v-action="copy">
        <Icon :name="copied ? 'check' : 'copy'" :class="[`text-2xs`, copied ? `text-success` : ``]" />
        {{ copied ? `Copied` : label }}
    </button>
    <button v-else ref="root" type="button" aria-label="Copy" :class="ui.iconButton(`text-subtle`)" v-action="copy">
        <Icon class="text-2xs" :name="copied ? 'check' : 'copy'" :class="copied ? 'text-success' : ''" />
    </button>
</template>

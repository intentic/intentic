<!-- Copy-to-clipboard button with built-in "Copied" feedback (green check for 1.5s). With `label` it
     renders as a bordered chip ("Copy" → "Copied"), or as the view's call to action when `stretch` says
     copying IS the step; without a label, a bare icon button — pass aria-label / v-tooltip at the call site
     (they fall through to the button). -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { clipboardOf } from "../clipboard.js";
import { cmp } from "../cmp.js";

const {
    text,
    label = ``,
    stretch = false,
} = defineProps<{
    // Clipboard payload — a string, or a resolver fetched on click (e.g. an owner-only secret we
    // don't want to render on screen just to copy it).
    text: string | (() => string | Promise<string>);
    // Visible text (e.g. "Copy"); omit for a bare icon-only button.
    label?: string;
    /* Same meaning as Segmented's `stretch`: the button owns its row — full width, touch-sized, and dressed
     * as the view's call to action — for the screen where copying IS the step rather than a convenience
     * beside content (setup's install command on a phone: the command cannot be run where it is read, so
     * getting it onto the clipboard is the whole task). The default chip is a mouse target at ~20px tall. */
    stretch?: boolean;
}>();

const copied = ref(false);
// The pressed button, which is also the window the write must go through — see clipboardOf.
const root = ref<HTMLButtonElement>();

const chrome = computed(() =>
    stretch
        ? cmp.buttonPrimary(`min-h-10 w-full gap-1.5 px-3 text-sm`)
        : `inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:border-line-strong hover:text-content`,
);

const copy = async (): Promise<void> => {
    try {
        // ponytail: awaiting a resolver before writeText works in Chromium/Firefox; Safari's
        // user-gesture rule may reject it — if so, upgrade to
        // clipboard.write([new ClipboardItem({ 'text/plain': promise })]).
        await clipboardOf(root.value).writeText(typeof text === `function` ? await text() : text);
        copied.value = true;
        setTimeout(() => (copied.value = false), 1500);
    } catch {
        // Clipboard may be unavailable (insecure context); the user can still select the text.
    }
};
</script>

<template>
    <button v-if="label" ref="root" type="button" :class="chrome" @click="copy">
        <Icon :name="copied ? 'check' : 'copy'" :class="[stretch ? `` : `text-2xs`, copied ? `text-success` : ``]" />
        {{ copied ? `Copied` : label }}
    </button>
    <button
        v-else
        ref="root"
        type="button"
        aria-label="Copy"
        class="inline-flex shrink-0 items-center justify-center rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-content"
        @click="copy"
    >
        <Icon class="text-2xs" :name="copied ? 'check' : 'copy'" :class="copied ? 'text-success' : ''" />
    </button>
</template>

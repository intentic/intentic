<!-- Copy-to-clipboard button with built-in "Copied" feedback (green check for 1.5s). With `label` it
     renders as a bordered chip ("Copy" → "Copied"); without a label, a bare icon button — pass aria-label /
     v-tooltip at the call site (they fall through to the button).

     EMPHASIS AND WIDTH ARE SEPARATE QUESTIONS, which is why there are two flags. `stretch` used to carry
     both, so a caller who needed "this is the action to take" had no way to say it without also claiming the
     whole row — and setup's stuck-wait banner, where copying the command again IS the way out, ended up
     wearing the quiet chip meant for a copy-as-convenience beside content.
     TONE is a third question and needs no flag of its own: `severity` falls through to the Button like any
     other attr, for the emphasised copy that must not outshout the card's own primary action (setup's phone
     command, sitting under the email handoff that is the recommended path there). -->
<script setup lang="ts">
import Button from "primevue/button";
import { computed, ref } from "vue";
import { clipboardOf } from "../clipboard.js";

const {
    text,
    label = ``,
    cta = false,
    stretch = false,
} = defineProps<{
    // Clipboard payload — a string, or a resolver fetched on click (e.g. an owner-only secret we
    // don't want to render on screen just to copy it).
    text: string | (() => string | Promise<string>);
    // Visible text (e.g. "Copy"); omit for a bare icon-only button.
    label?: string;
    /* Dress it as the action to take rather than a convenience — for the moment where copying IS the next
     * step and the user needs to see that at a glance (setup's "nothing has reached us" banner). Inline: it
     * changes the button's weight, not its place in the row. */
    cta?: boolean;
    /* Same meaning as Segmented's `stretch`: the button owns its row — full width and touch-sized — for the
     * screen where copying is the whole task (setup's install command on a phone: the command cannot be run
     * where it is read, so getting it onto the clipboard is all there is to do). Implies `cta`; the default
     * chip is a mouse target at ~20px tall. */
    stretch?: boolean;
}>();

// Fired only on a write that actually landed, for the caller whose FLOW turns on the copy having happened —
// setup's install command is handed to a terminal this browser cannot see, so the copy is the last thing it
// can observe before the user leaves for it. The button's own "Copied" flash is separate and still local.
const emit = defineEmits<{ copied: [] }>();

const copied = ref(false);
/* The pressed button, which is also the window the write must go through — see clipboardOf. The emphasised
 * spellings are a <Button>, so what this ref holds is the component; `$el` is the element the clipboard call
 * needs, and it is optional here only because the quiet spelling is a plain <button> and this ref serves both. */
const root = ref<HTMLButtonElement | { $el: HTMLElement }>();
const rootEl = (): HTMLElement | undefined => (root.value === undefined ? undefined : `$el` in root.value ? root.value.$el : root.value);

// Weight, not geometry: the emphasised spellings are the app's one action button, so the only thing said here
// is how much room it takes. Quiet stays a bare chip — a copy-as-convenience beside content is not an action.
const chrome = computed(() => (stretch ? `min-h-10 w-full gap-1.5 px-3 text-sm` : `gap-1.5`));

const copy = async (): Promise<void> => {
    try {
        // ponytail: awaiting a resolver before writeText works in Chromium/Firefox; Safari's
        // user-gesture rule may reject it — if so, upgrade to
        // clipboard.write([new ClipboardItem({ 'text/plain': promise })]).
        await clipboardOf(rootEl()).writeText(typeof text === `function` ? await text() : text);
        copied.value = true;
        emit(`copied`);
        setTimeout(() => (copied.value = false), 1500);
    } catch {
        // Clipboard may be unavailable (insecure context); the user can still select the text.
    }
};
</script>

<template>
    <Button v-if="label && (cta || stretch)" ref="root" size="small" :class="chrome" @click="copy">
        <Icon :name="copied ? 'check' : 'copy'" :class="[stretch ? `` : `text-2xs`, copied ? `text-success` : ``]" />
        {{ copied ? `Copied` : label }}
    </Button>
    <button
        v-else-if="label"
        ref="root"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:border-line-strong hover:text-content"
        @click="copy"
    >
        <Icon :name="copied ? 'check' : 'copy'" :class="[`text-2xs`, copied ? `text-success` : ``]" />
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

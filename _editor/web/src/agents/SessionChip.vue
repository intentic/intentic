<script setup lang="ts">
import { clipboardOf } from "@intentic/ui";
import { ref } from "vue";

/* THE SESSION'S NAME, wherever it is printed — the branch an isolated agent works on, which is also the name of
 * its worktree and the id in its page's address. One component so the string looks the same on every surface
 * and answers to the same press, because it is the only thing joining this app to git, the disk and the CLI:
 * a name you have to retype off the screen is not an identifier, it is a picture of one.
 *
 * COPY IS THE CLICK, and it copies EXACTLY what the chip shows. A control that puts something else on the
 * clipboard than the text under the cursor is the fastest way to make people stop trusting copy controls at
 * all — so the board's chip, which shows the branch, hands over the branch. The other forms of the same name
 * (the bare id, the link) live in the identity panel, where they are labelled and visible before the press.
 *
 * `reveal` is the second surface: the agent's own page, where the chip opens that panel instead of copying.
 * The chevron is what keeps the two honest — a chip that opens something has to look different from a chip
 * that copies, or the press is a coin flip.
 *
 * NO HOVER LABEL on either spelling. A hint here could only ever have named the press ("copy this"), and the
 * press names itself the instant it happens: the glyph turns into a check and the name into "Copied". The
 * screen reader keeps the sentence (aria-label), because it has no glyph to watch. */

const {
    branch,
    reveal = false,
    compact = false,
} = defineProps<{
    branch: string;
    // Open the identity panel rather than copy — the agent's own page, the one surface that shows every form.
    reveal?: boolean;
    // Glyph only, for a header row with no width to spare (the detail page on a phone).
    compact?: boolean;
}>();
const emit = defineEmits<{ reveal: [event: MouseEvent] }>();

const copied = ref(false);
const root = ref<HTMLButtonElement>();

/* The press stops here in every sense: the board card underneath is a click target AND a drag handle, so a
 * copy that bubbled would also focus the agent, and a press that bubbled would start dragging the card to
 * another lane. (`grab` already lets a <button> through, but the click and the double-click do not.) */
const press = async (event: MouseEvent): Promise<void> => {
    if (reveal) {
        emit(`reveal`, event);
        return;
    }
    try {
        await clipboardOf(root.value).writeText(branch);
        copied.value = true;
        setTimeout(() => (copied.value = false), 1500);
    } catch {
        // Clipboard may be unavailable (insecure context); the name is still readable on the chip.
    }
};
</script>

<template>
    <button
        ref="root"
        type="button"
        class="inline-flex min-w-0 items-center gap-1 rounded font-mono text-2xs text-subtle transition-colors hover:text-content"
        :class="compact ? `h-7 w-7 shrink-0 justify-center hover:bg-overlay` : `max-w-full shrink`"
        :aria-label="reveal ? `Session name — ${branch}` : `Copy session name — ${branch}`"
        @click.stop="press"
        @dblclick.stop
    >
        <Icon :name="copied ? `check` : `code`" class="shrink-0 text-2xs" :class="copied ? `text-success` : ``" />
        <template v-if="!compact">
            <span v-if="copied" class="shrink-0 font-sans text-success">Copied</span>
            <span v-else class="truncate">{{ branch }}</span>
            <Icon v-if="reveal" name="chevron-down" class="shrink-0 text-[0.6rem] opacity-60" />
        </template>
    </button>
</template>

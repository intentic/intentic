<script setup lang="ts">
import type { IconName } from "@intentic/ui";

// THE ONE LINE ABOVE THE COMPOSER WHEN THIS CHAT CANNOT SEND YET, as a card: a mark, the sentence, and the presses that
// answer it at the end. Every such line draws in it, a sandbox's (ChatAccountPanel.vue: a sign-in waiting or failed, a
// model not the reader's, nothing connected) and this computer's (ComputerHarnessStrip.vue: a coding agent not set up,
// signed out, or being set up), so a reader meets the same line, in the same place, whichever side the chat runs on.

const { spin = false, wide = false } = defineProps<{
    icon: IconName;
    // The mark's ink: what it says (waiting, failed, locked) before the words do.
    tone: string;
    spin?: boolean;
    // The sentence keeps a reading width before the presses wrap under it, where it is a whole thought of its own.
    wide?: boolean;
}>();
</script>

<template>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl bg-card shadow-sm px-4 py-3 text-2xs text-muted">
        <Icon :name="icon" :spin="spin" class="shrink-0" :class="tone" />
        <span class="flex-1 text-left" :class="wide ? `min-w-[12rem]` : `min-w-0`"><slot /></span>
        <!-- The presses wrap among themselves rather than past the card's edge, in a chat as narrow as a docked column. -->
        <span class="flex max-w-full flex-wrap items-center gap-x-3 gap-y-1.5"><slot name="actions" /></span>
    </div>
</template>

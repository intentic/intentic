<script setup lang="ts">
import { type IconName, type Tone, toneDot, toneWash } from "@intentic/ui";

/* A NOTICE'S MARK, which says what kind of thing happened before a word is read: a ring in its tone with the glyph
   inside for anything that ended some way (finished, failed, fired, refused), a spinner for a wait still running, and a
   bead for what only happened to the turn's machinery, which has no outcome to colour. */

const { tone, icon, spinning = false, size = `md` } = defineProps<{
    tone: Tone;
    icon: IconName;
    spinning?: boolean;
    // `md` for a row's or a card's lead, `sm` for a row inside a card.
    size?: `sm` | `md`;
}>();
</script>

<template>
    <span v-if="spinning" class="inline-flex shrink-0 items-center justify-center" :class="size === `md` ? `size-4` : `size-3.5`" aria-hidden="true">
        <Icon name="spinner" spin class="text-xs text-info" />
    </span>
    <span
        v-else-if="tone === `neutral`"
        class="inline-flex shrink-0 items-center justify-center"
        :class="size === `md` ? `size-4` : `size-3.5`"
        aria-hidden="true"
        data-notice-bead
    >
        <span :class="toneDot(`neutral`, `size-1.5 rounded-full`)" />
    </span>
    <span
        v-else
        :class="toneWash(tone, `inline-flex shrink-0 items-center justify-center rounded-full`, size === `md` ? `size-4 text-3xs` : `size-3.5 text-[0.5625rem]`)"
        aria-hidden="true"
    >
        <Icon :name="icon" />
    </span>
</template>

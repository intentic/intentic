<!-- Numbered step card for the setup wizard: card chrome + a badge (the step number, or a check once
     `done`) + title, with a right-aligned `actions` slot for header affordances (an InfoHint, a "Check
     now" button). Replaces the repeated `<section>` + badge markup across the setup steps so their chrome
     stays identical; each step supplies its own (collapsed or expanded) body via the default slot.

     A card that is the WHOLE flow rather than one step of several passes `icon` instead of `step`: a lone
     "1" badge promises a step 2 that is never coming, which reads as a page that failed to finish loading.

     THE ACTIONS SLOT IS THE CARD'S TOP-RIGHT CORNER, at every width, and it is sized for one thing: an
     icon-sized affordance (an InfoHint's (i)). That is what makes it safe to share the title's line on a
     phone. It used to wrap to a second row there, because the slot once held a "Check now" BUTTON and
     sharing the line turned "Waiting for your sandbox to report in…" into a three-line column beside it —
     a title that has to be read vertically reads as a broken layout. A 16px icon costs the title one word;
     a second row cost it a corner, and a hint alone on a row of its own reads as a stray control rather
     than as something belonging to the heading beside it. Put anything wider than an icon in the body. -->
<script setup lang="ts">
import { type IconName } from "../icons/iconSets.js";

const { step, icon, title, done = false } = defineProps<{ step?: number; icon?: IconName; title: string; done?: boolean }>();
</script>

<template>
    <section class="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 md:p-5">
        <div class="flex items-center gap-2.5">
            <div class="flex min-w-0 flex-1 items-center gap-2.5">
                <span
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold"
                    :class="done ? `border-success/40 bg-success/10 text-success` : `border-line bg-canvas text-muted`"
                >
                    <Icon name="check" v-if="done" :aria-label="`${title} — done`" />
                    <template v-else-if="step !== undefined">{{ step }}</template>
                    <Icon v-else-if="icon" :name="icon" />
                </span>
                <h2 class="min-w-0 font-semibold leading-tight">{{ title }}</h2>
            </div>
            <div v-if="$slots['actions']" class="flex shrink-0 items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <slot />
    </section>
</template>

<!--
    Numbered step card for the setup wizard: a badge (number, or a check once `done`), a title, and a right-aligned `#actions` slot sized for one
    icon affordance only. Pass `icon` instead of `step` for a card that is the whole flow, not one step of several.
-->
<script setup lang="ts">
import type { IconName } from "../../icons/iconSets.js";

const { step, icon, title, done = false } = defineProps<{ step?: number; icon?: IconName; title: string; done?: boolean }>();
</script>

<template>
    <!-- The design system's own plate (`.ui-card`: radius, rule and fill from the tokens), never a hand-rolled
         copy of it. A card that spells its own chrome is a card a SKIN cannot dress: sanctum styles `.ui-card`
         (stone, a gold rule, a ledge of caught light) and leaves an open-coded `rounded-2xl border bg-card`
         beside it as a flat rectangle. Padding stays a utility, because it is the one part that is responsive. -->
    <section class="ui-card flex flex-col gap-3 p-4 md:p-5">
        <div class="flex items-center gap-2.5">
            <div class="flex min-w-0 flex-1 items-center gap-2.5">
                <span
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-2xs font-medium"
                    :class="done ? `border-success/40 bg-success/10 text-success` : `border-line bg-canvas text-muted`"
                >
                    <Icon name="check" v-if="done" :aria-label="`${title}: done`" />
                    <template v-else-if="step !== undefined">{{ step }}</template>
                    <Icon v-else-if="icon" :name="icon" />
                </span>
                <!-- Medium, not semibold. A card of steps is a stack of headings, and set in bold they read as
                     one solid block rather than as a spine: the badge beside each one already says "this is a
                     step", so the weight only has to lift the title off the body under it. -->
                <h2 class="min-w-0 font-medium leading-tight">{{ title }}</h2>
            </div>
            <div v-if="$slots['actions']" class="flex shrink-0 items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <slot />
    </section>
</template>

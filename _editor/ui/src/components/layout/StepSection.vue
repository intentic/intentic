<!-- Numbered step card for the setup wizard: a badge (number, or a check once `done`), a title. -->
<script setup lang="ts">
import type { IconName } from "../../icons/iconSets.js";

const { step, icon, title, done = false } = defineProps<{ step?: number; icon?: IconName; title: string; done?: boolean }>();
</script>

<template>
<!-- The design system's own plate (`.ui-card`: radius, rule and fill from the tokens), never a hand-rolled copy of it. -->
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
<!-- Medium, not semibold. -->
                <h2 class="min-w-0 font-medium leading-tight">{{ title }}</h2>
            </div>
            <div v-if="$slots['actions']" class="flex shrink-0 items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <slot />
    </section>
</template>

<script setup lang="ts">
import { useId } from "vue";

// One labelled part of an open extension row: its name, and at most one line saying what it is, in a fixed column
// beside the content on a wide row, above it on a narrow one. The drawer rules them apart; a section draws no box of its
// own, so five of them read as one record rather than five cards.

const { label, caption } = defineProps<{ label: string; caption?: string }>();

const labelId = useId();
</script>

<template>
    <section :aria-labelledby="labelId" class="grid gap-x-6 gap-y-2 py-3.5 @2xl:grid-cols-[10rem_minmax(0,1fr)]">
        <div class="min-w-0">
            <p :id="labelId" class="text-xs font-medium text-content">{{ label }}</p>
            <p v-if="caption" class="mt-0.5 text-2xs text-subtle">{{ caption }}</p>
        </div>
        <div class="min-w-0">
            <slot />
        </div>
    </section>
</template>

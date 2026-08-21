<!-- The standard title block for every rail panel: one h1 with an optional inline info hint / status badge
     (#info), an optional right-aligned action cluster (#actions), and a muted description line. Unifies the
     hand-rolled <header> blocks that had drifted across mb-4/mb-5/mb-6 and disagreed on whether the info hint
     sat inline with the title. Sits inside a <Page>; the page owns width, the header owns nothing but its own
     rhythm. -->
<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
    <header class="mb-6">
        <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-2">
                <h1 class="text-2xl font-semibold">{{ title }}</h1>
                <slot name="info" />
            </div>
            <div v-if="$slots['actions']" class="flex shrink-0 items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <p v-if="description !== undefined || $slots['description']" class="mt-1 text-sm text-muted">
            <slot name="description">{{ description }}</slot>
        </p>
    </header>
</template>

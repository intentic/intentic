<script setup lang="ts">
/* The +additions / −deletions line-count badge shown on a changed-file row — the Changes panel, the agent
 * review, the git-graph commit detail, and the chat tool diff all render it, so the +/- idiom stays identical
 * across every review surface. Renders nothing when neither count is known (a binary or untracked file — git
 * reports no numstat), so callers can drop it in unconditionally. A zero count is omitted (a pure rename shows
 * neither side); when both are zero the whole badge is empty and collapses. */
const { additions, deletions } = defineProps<{ additions?: number; deletions?: number }>();
</script>

<template>
    <span v-if="additions !== undefined || deletions !== undefined" class="shrink-0 font-mono text-[0.65rem]">
        <span v-if="additions" class="text-success">+{{ additions }}</span>
        <span v-if="deletions" class="text-danger" :class="{ 'ml-1': additions }">−{{ deletions }}</span>
    </span>
</template>

<script setup lang="ts">
/* The +additions / −deletions line-count badge shown on a changed-file row: the Changes panel, the agent review, the git-history commit detail. */
const { additions, deletions } = defineProps<{ additions?: number; deletions?: number }>();
</script>

<template>
    <span v-if="additions !== undefined || deletions !== undefined" class="shrink-0 font-mono text-3xs">
        <span v-if="additions" class="text-success">+{{ additions }}</span>
        <span v-if="deletions" class="text-danger" :class="{ 'ml-1': additions }">−{{ deletions }}</span>
    </span>
</template>

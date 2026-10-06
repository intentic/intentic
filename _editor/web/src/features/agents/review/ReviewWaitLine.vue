<!-- One quiet line for a wait on the review page, standing where the first row of the answer will land. Its inset is the
     caller's: the list's rows and the diff's lines start at different distances from the edge. -->
<script setup lang="ts">
const { label } = defineProps<{
    /** What is being waited on; said and announced, since there are no bars around it to stand in for the content. */
    label: string;
}>();
</script>

<template>
    <p class="flex items-center gap-1.5 py-2 text-2xs text-subtle" role="status" aria-busy="true">
        <Icon name="spinner" spin class="shrink-0 text-2xs" aria-hidden="true" />
        <span class="min-w-0 truncate">{{ label }}</span>
    </p>
</template>

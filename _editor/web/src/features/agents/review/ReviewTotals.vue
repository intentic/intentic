<script setup lang="ts">
import type { LineStat } from "@intentic/code-read";
import ReviewStat from "../../workspace/changes/ReviewStat.vue";

// A whole review's totals: its size as git counts it (ReviewStat's `whole`), the number the board card shows for the
// same work, the code-only reading in its hover; then how many files are marked reviewed. A check and "N/total" reads
// as reviewed-of-total on its own, no hover-only shortcut hint needed.

defineProps<{
    code: LineStat;
    additions: number;
    deletions: number;
    viewed: number;
    total: number;
}>();
</script>

<template>
    <span class="inline-flex shrink-0 items-center gap-1.5">
        <ReviewStat :code="code" :additions="additions" :deletions="deletions" whole />
        <span class="inline-flex items-center gap-0.5 whitespace-nowrap text-2xs text-subtle"> <Icon name="check" class="text-2xs" />{{ viewed }}/{{ total }} </span>
    </span>
</template>

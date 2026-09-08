<script setup lang="ts">
import { computed } from "vue";
import { ProgressRing, StatusTally, type TallyItem } from "@intentic/extension-ui";

// Orientation line (how runs went, and the pass rate), drawn in three places (title row, above the list on a narrow
// pane, its own skeleton) that must stay one shape. Counts are `<StatusTally>`'s; this adds the pass rate riding its
// trailing slot.

const {
    items = [],
    rate = undefined,
    skeleton = false,
} = defineProps<{
    items?: readonly TallyItem[];
    /** Percent of the runs in view that passed; absent means nothing has finished yet. */
    rate?: number | undefined;
    /** Draw the line's shape rather than its numbers, while the counts are still being fetched. */
    skeleton?: boolean;
}>();

// Green above 80, amber to 50, red below: the thresholds where 'is CI trustworthy' changes answer.
const rateTone = computed(() => {
    if (rate === undefined || rate >= 80) {
        return `text-success`;
    }
    return rate >= 50 ? `text-warning` : `text-danger`;
});
</script>

<template>
    <!-- Three placeholders for the tally's three counts; the ring is a fourth, riding the real one's slot. -->
    <StatusTally :items="skeleton ? [] : items" :skeleton="skeleton ? 3 : 0">
        <div v-if="skeleton" class="flex h-5 items-center gap-2" aria-hidden="true">
            <span class="skeleton h-5 w-5 rounded-full"></span>
            <span class="skeleton h-3 w-20"></span>
        </div>
        <span v-else-if="rate !== undefined" class="flex items-center gap-2">
            <ProgressRing :value="rate" :size="20" :stroke="2.5" :class="rateTone" />
            <span class="text-xs text-muted">{{ rate }}% pass rate</span>
        </span>
    </StatusTally>
</template>

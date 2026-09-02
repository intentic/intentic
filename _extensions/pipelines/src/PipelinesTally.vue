<script setup lang="ts">
import { computed } from "vue";
import { ProgressRing, StatusTally, type TallyItem } from "@intentic/extension-ui";

/* THE BOARD'S ORIENTATION LINE: how the runs in view went, and what share of them passed.
 *
 * Its own component because it is drawn in three places now and has to be the same line in all of them: on the
 * title row where it usually lives, above the list on a pane too narrow to hold it beside the title and the
 * repository picker, and in its loading form while the first /ci/runs response is still out. The skeleton was
 * the copy that proved the point, it had the ring's geometry written out a second time in PipelinesSkeleton, and
 * a line whose shape is stated twice is a line that eventually reads two ways.
 *
 * The counts themselves are <StatusTally>'s (the app's one tally vocabulary); what this adds is the pass rate
 * that rides its trailing slot, and the decision that the two travel together. */

const {
    items = [],
    rate = undefined,
    skeleton = false,
} = defineProps<{
    items?: readonly TallyItem[];
    /** Percent of the runs in view that passed. Absent ⇒ nothing has finished, so there is no rate to state. */
    rate?: number | undefined;
    /** Draw the line's shape rather than its numbers, while the counts are still being fetched. */
    skeleton?: boolean;
}>();

// Green above 80, amber down to 50, red below it: a pass rate is only ever read as "is CI trustworthy", and
// these are the cuts at which that answer changes.
const rateTone = computed(() => {
    if (rate === undefined || rate >= 80) {
        return `text-success`;
    }
    return rate >= 50 ? `text-warning` : `text-danger`;
});
</script>

<template>
    <!-- Three placeholders because the tally has three counts worth drawing at zero; the ring is the fourth
         item and rides the same slot the real one does. -->
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

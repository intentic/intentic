<script setup lang="ts">
import { computed } from "vue";
import type { MachineHours } from "./hostedHours";

// One machine's hours, drawn the same way wherever they are shown (Billing's list, the sandbox's own Usage tab): whose
// hours they are, one line about what is left, and a bar saying the same thing, so colour never carries it alone. Hours
// counted against no limit get the line and no bar, since there is nothing to fill.

// `grow`: the fill extends from empty to the hours used as the meter is drawn (motion.css `ui-grow-x`), on the usage
// view where it stands among charts that do; Billing's list of machines leaves it off.
const props = defineProps<{ hours: MachineHours; grow?: boolean }>();

const spent = computed(() => props.hours.meter !== undefined && props.hours.meter.remainingMinutes === 0);
const low = computed(() => props.hours.meter !== undefined && props.hours.meter.fraction <= 0.125);
</script>

<template>
    <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span class="text-xs font-medium text-content">{{ props.hours.label }}</span>
            <span class="text-2xs tabular-nums" :class="spent ? `text-warning` : `text-muted`">{{ props.hours.line }}</span>
        </div>
        <div v-if="props.hours.meter" class="h-1.5 w-full overflow-hidden rounded-full bg-content/10" role="presentation">
            <!-- Growing, the recipe moves the width too; a utility's transition list would outrank it and drop the growth. -->
            <div
                class="h-full rounded-full"
                :class="[low ? `bg-warning` : `bg-primary-fill`, props.grow ? `ui-grow-x` : `transition-[width]`]"
                :style="{ width: `${Math.round(props.hours.meter.fraction * 100)}%` }"
            />
        </div>
    </div>
</template>

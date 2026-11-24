<!-- Shelves as they land while they are read: one card, and per shelf a label beside a wrap of chips, as Skills and Memory draw them. -->
<script setup lang="ts">
import { Card } from "@intentic/ui";

const { shelves } = defineProps<{
    /** How many chips each shelf promises, in order: the shortest list worth promising, not the longest one seen. */
    shelves: readonly number[];
}>();

// Walked by shelf and chip, so no two neighbours are the same length and a wrap does not read as a pattern.
const CHIP_WIDTHS = [`w-28`, `w-20`, `w-36`, `w-24`, `w-32`];
</script>

<template>
    <Card aria-hidden="true">
        <dl class="flex flex-col gap-3">
            <div v-for="(chips, shelf) in shelves" :key="shelf" class="flex flex-col gap-1.5 @xl:flex-row @xl:gap-3">
                <dt class="flex min-h-[1lh] items-center text-xs @xl:w-32 @xl:shrink-0 @xl:pt-1.5"><span class="skeleton block h-2.5 w-16" /></dt>
                <dd class="flex min-w-0 flex-wrap gap-1.5">
                    <span v-for="chip in chips" :key="chip" class="skeleton block h-6.5 rounded-full" :class="CHIP_WIDTHS[(shelf * 2 + chip) % CHIP_WIDTHS.length]" />
                </dd>
            </div>
        </dl>
    </Card>
</template>

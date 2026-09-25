<!-- One lane of a rail: a header labelling the cards under it, with no slab of its own. Used by the chat rail and the subagent list; the fleet board draws the same header (LaneHeader) over its own columns. -->
<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import LaneHeader from "./LaneHeader.vue";

defineProps<{
    label: string;
    dot?: string;
    icon?: IconName;
    count?: string | number;
}>();
</script>

<template>
    <section class="lane flex min-w-0 flex-col">
<!-- `px-3`: the lane insets its cards by `px-2`, so the header sits 4px inside them, as the board's does. Paints nothing, and cannot: pinning it would need a fill to occlude the cards passing under it, and a fill here is a flat patch over whatever the panel's skin has drawn. -->
        <LaneHeader :label="label" :dot="dot" :icon="icon" :count="count" class="px-3">
            <template #actions><slot name="actions" /></template>
        </LaneHeader>
<!-- The lane's contents, inset and spaced by the LANE rather than by each caller. -->
        <div class="flex min-w-0 flex-col gap-2.5 px-2 pb-2">
            <slot />
        </div>
    </section>
</template>

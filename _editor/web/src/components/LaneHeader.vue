<!-- A lane's header: its mark, its name, then its own bulk act. The one drawing of it, for the
     fleet board's columns, the chat rail and the subagent list alike (RailLane wraps it). It is the kit's section
     header at the rail's tier (<SectionHeader density="dense">), at a lane's height: it paints nothing and sets no
     horizontal padding, since the board's cards run edge to edge under `px-1`, a rail's are inset by its lane, and each
     caller insets the header to sit 4px inside its cards. -->
<script setup lang="ts">
import { type IconName, SectionHeader } from "@intentic/ui";

defineProps<{
    label?: string;
    icon?: IconName;
}>();
</script>

<template>
    <!-- The lane's `<header>`, holding the kit's header. `min-h-8`, not `h-8`: a lane too narrow for its acts wraps them
         under the label instead of running them off it. -->
    <header class="flex min-h-8 shrink-0 items-center">
        <SectionHeader :label="label" density="dense" class="min-w-0 flex-1">
            <!-- A header that stands for something else for a while (the board's archive) draws its own mark and name. -->
            <template #mark>
                <slot name="mark"><Icon v-if="icon !== undefined" :name="icon" class="shrink-0 text-2xs text-subtle" /></slot>
            </template>
            <template v-if="$slots[`label`]" #label><slot name="label" /></template>
            <template v-if="$slots[`info`]" #info><slot name="info" /></template>
            <!-- The lane's own bulk act, where the lane is the target: "Clear". -->
            <template v-if="$slots[`actions`]" #actions><slot name="actions" /></template>
        </SectionHeader>
    </header>
</template>

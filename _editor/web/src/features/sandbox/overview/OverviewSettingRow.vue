<!-- ONE ROW OF THE OVERVIEW'S LISTS, as a pair: what it is on the left, quiet, and its value on the right, where it is
     changed (overviewLook.ts draws a value that is its own press). The default slot is the value and whatever a row has to
     say under it (a refusal, a change in flight); `action` is a control that is not the value itself, a switch or a
     copy, at the row's end. Rendered inside a list's <dl>, as one name with its descriptions. -->
<script setup lang="ts">
defineProps<{
    label: string;
    // The id of the row's switch, when it has one: the name then presses it.
    labelFor?: string;
    // The name over its value rather than beside it: for a value that needs the row's whole width, an address.
    stacked?: boolean;
}>();
</script>

<template>
    <div class="flex min-w-0 gap-x-3 py-1" :class="stacked ? `flex-wrap items-center` : `items-start`">
        <dt class="shrink-0 text-xs text-subtle" :class="stacked ? `basis-full pt-1` : `w-28 py-1`">
            <label v-if="labelFor" :for="labelFor" class="cursor-pointer">{{ label }}</label>
            <template v-else>{{ label }}</template>
        </dt>
        <dd class="flex min-w-0 flex-1 flex-col items-start gap-1 text-xs text-content"><slot /></dd>
        <dd v-if="$slots[`action`]" class="flex h-6 shrink-0 items-center"><slot name="action" /></dd>
    </div>
</template>

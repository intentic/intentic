<!-- ONE SETTING OF THE OVERVIEW'S LIST: its name, what it is set to in a quieter line under it, and the one control that
     changes it at the row's end, where the eye finds every row's control in the same column. The default slot is the
     value's line and whatever a row has to say under it (a refusal, a change in flight); `action` is the control, absent
     for a reader who may not change it. Rendered inside the list's <dl>, as one name with its descriptions. -->
<script setup lang="ts">
defineProps<{
    label: string;
    // The id of the row's switch, when it has one: the name then presses it.
    labelFor?: string;
}>();
</script>

<template>
    <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-3 first:pt-0 last:pb-0">
        <dt class="text-sm font-medium text-content">
            <label v-if="labelFor" :for="labelFor" class="cursor-pointer">{{ label }}</label>
            <template v-else>{{ label }}</template>
        </dt>
        <dd class="col-start-1 flex min-w-0 flex-col gap-1 text-xs text-muted"><slot /></dd>
        <dd v-if="$slots.action" class="col-start-2 row-span-2 row-start-1 flex shrink-0 items-center"><slot name="action" /></dd>
    </div>
</template>

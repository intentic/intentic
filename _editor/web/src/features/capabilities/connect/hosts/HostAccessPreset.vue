<!-- A device's access as a posture: the preset sets all switches at once. The switches below it say what it grants, so
     no sentence repeats them here. -->
<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

defineProps<{
    /** The preset the switches spell now, or `` for a hand-tuned mix. */
    preset: string;
    options: readonly { readonly value: string; readonly label: string }[];
}>();
const emit = defineEmits<{ apply: [key: string] }>();
</script>

<template>
    <label class="flex items-center justify-between gap-4">
        <span class="ui-field-label min-w-0">{{ t(`capabilities.words.access`) }}</span>
        <SegmentedControl class="shrink-0" :model-value="preset" :options="options" @update:model-value="emit(`apply`, $event)" />
    </label>
</template>

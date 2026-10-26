<script setup lang="ts">
import { Picker } from "@intentic/extension-ui";
import { computed } from "vue";
import { useServices } from "./useServices";
import { t } from "../i18n.js";
const props = defineProps<{ modelValue: string; inherit?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const { available, options, summary } = useServices();
const choices = computed(() => options(props.modelValue, props.inherit));
</script>
<template>
    <div v-if="available" class="ui-field min-w-0">
        <span class="ui-field-label">{{ t(`service.runsAs`) }}</span>
        <Picker :model-value="modelValue" :options="choices" :aria-label="t(`service.runsAs`)" class="w-full" @update:model-value="emit(`update:modelValue`, $event ?? ``)" />
        <p class="text-2xs text-subtle">{{ inherit && modelValue === `` ? t(`service.inherit`) : summary(modelValue) }}</p>
    </div>
</template>

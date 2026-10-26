<script setup lang="ts">
import { Row, ui } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useT } from "@intentic/ui/i18n";
const model = defineModel<string[]>();
defineProps<{ label: string; readonly?: boolean; note?: string; required?: boolean }>();
const t = useT();
const change = (event: Event): void => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
        return;
    }
    model.value = field.value
        .split(/[,\n]/u)
        .map((key) => key.trim())
        .filter(Boolean);
};
</script>
<template>
    <Row :title="label" :description="note">
        <template #control>
            <ToggleSwitch
                v-if="!required"
                :model-value="model !== undefined"
                :disabled="readonly"
                :aria-label="label"
                @update:model-value="model = $event ? [] : undefined"
            />
        </template>
        <template #below>
            <input
                v-if="model !== undefined"
                :value="model.join(`, `)"
                :readonly="readonly"
                :aria-label="label"
                :class="ui.input({ size: `sm` }, `w-full`)"
                @change="change"
            />
            <span class="text-xs text-subtle">{{
                model === undefined ? t(`organisations.accessPolicy.unlimited`) : t(`organisations.accessPolicy.listNote`)
            }}</span>
        </template>
    </Row>
</template>

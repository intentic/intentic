<script setup lang="ts">
import { CEILING_SWITCHES, type ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { Row, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
const model = defineModel<ToolCeiling>({ required: true });
defineProps<{ readonly?: boolean }>();
const t = useT();
// What a select now says; empty for an event from anything else.
const picked = (event: Event): string => (event.target instanceof HTMLSelectElement ? event.target.value : ``);
const filesChanged = (event: Event): void => {
    const value = picked(event);
    model.value = { ...model.value, files: value === `none` || value === `read` || value === `write` ? value : undefined };
};
const switchChanged = (shelf: (typeof CEILING_SWITCHES)[number], event: Event): void => {
    const value = picked(event);
    model.value = { ...model.value, [shelf]: value === `unlimited` ? undefined : value === `true` };
};
</script>
<template>
    <Row :title="t(`organisations.accessPolicy.files`)">
        <template #control>
            <select
                :value="model.files ?? `unlimited`"
                @change="filesChanged"
                :disabled="readonly"
                :aria-label="t(`organisations.accessPolicy.files`)"
                :class="ui.input({ size: `sm` })"
            >
                <option value="unlimited">{{ t(`organisations.accessPolicy.unlimited`) }}</option>
                <option v-for="value in [`none`, `read`, `write`] as const" :key="value" :value="value">
                    {{ t(`organisations.accessPolicy.${value}`) }}
                </option>
            </select>
        </template>
    </Row>
    <Row v-for="shelf in CEILING_SWITCHES" :key="shelf" :title="t(`organisations.accessPolicy.${shelf}`)">
        <template #control>
            <select
                :value="model[shelf] === undefined ? `unlimited` : String(model[shelf])"
                @change="switchChanged(shelf, $event)"
                :disabled="readonly"
                :aria-label="t(`organisations.accessPolicy.${shelf}`)"
                :class="ui.input({ size: `sm` })"
            >
                <option value="unlimited">{{ t(`organisations.accessPolicy.unlimited`) }}</option>
                <option value="false">{{ t(`organisations.accessPolicy.none`) }}</option>
                <option value="true">{{ t(`organisations.accessPolicy.allowed`) }}</option>
            </select>
        </template>
    </Row>
</template>

<!-- The templates a draft can start from, found by typing, grouped by whether they watch this workspace or answer something outside it. -->
<script setup lang="ts">
import type { AutomationTemplate } from "@intentic/sandbox-contract/schemas/automations";
import { Picker, type PickerGroup, type PickerOption } from "@intentic/extension-ui";
import { computed } from "vue";
import { glyph } from "../catalog";
import { t } from "../i18n.js";

const props = defineProps<{
    templates: readonly AutomationTemplate[];
    /** The one the draft was started from, while its trigger still matches. */
    picked: AutomationTemplate | undefined;
}>();
const emit = defineEmits<{ pick: [template: AutomationTemplate] }>();

const options = computed<readonly PickerGroup[]>(() => {
    const option = (template: AutomationTemplate): PickerOption => {
        const base = { value: template.id, label: template.title, icon: glyph(template.icon) ?? `bolt` } satisfies PickerOption;
        const hint = template.description ?? template.note;
        return hint === undefined ? base : { ...base, hint };
    };
    return [
        { label: t(`automationComposer.codeChores`), options: props.templates.filter((template) => template.chore === true).map(option) },
        { label: t(`automationComposer.integrations`), options: props.templates.filter((template) => template.chore !== true).map(option) },
    ].filter((group) => group.options.length > 0);
});

const choose = (id: string | undefined): void => {
    const template = props.templates.find((candidate) => candidate.id === id);
    if (template !== undefined) {
        emit(`pick`, template);
    }
};
</script>

<template>
    <Picker
        :model-value="picked?.id"
        :options="options"
        variant="ghost"
        :search-threshold="0"
        :placeholder="t(`automationDraft.template`)"
        :aria-label="t(`automationDraft.template`)"
        :header="t(`automationDraft.template`)"
        @update:model-value="choose"
    />
</template>

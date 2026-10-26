<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { computed, ref, watch } from "vue";
import { Picker } from "@intentic/extension-ui";
import { useServices } from "../service/useServices";
import PropertyRow from "./PropertyRow.vue";
import { t } from "../i18n.js";
import { useAutomationPatch } from "./useAutomationPatch";
const props = defineProps<{ automation: AutomationSummary }>();
const { patch, error } = useAutomationPatch(computed(() => props.automation));
const { available, options, summary } = useServices();
const choice = ref(props.automation.runAs ?? ``);
watch(() => props.automation.runAs, (stored) => { choice.value = stored ?? ``; });
const choices = computed(() => options(choice.value));
const pick = async (runAs: string): Promise<void> => {
    if (runAs === (props.automation.runAs ?? ``)) {return;}
    choice.value = runAs;
    const saved = await patch((stored) => {
        const changed = { ...stored };
        if (runAs === ``) {delete changed.runAs;}
        else {changed.runAs = runAs;}
        return changed;
    });
    if (!saved) {choice.value = props.automation.runAs ?? ``;}
};
</script>
<template>
    <PropertyRow v-if="available" :label="t(`service.runsAs`)">
        <Picker :model-value="choice" :options="choices" variant="ghost" :aria-label="t(`service.runsAs`)" class="-mx-2 self-start text-sm" @update:model-value="pick($event ?? ``)" />
        <p class="text-2xs text-subtle">{{ summary(choice) }}</p>
        <span v-if="error" class="text-xs break-words text-danger">{{ error }}</span>
    </PropertyRow>
</template>

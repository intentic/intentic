<script setup lang="ts">
import { CEILING_SWITCHES, type ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { Picker } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
const { tools, disabled = false } = defineProps<{ tools: ToolCeiling | undefined; disabled?: boolean }>();
const emit = defineEmits<{ change: [tools: ToolCeiling] }>();
const t = useT();
const switches = computed(() => [
    { value: ``, label: t(`sandbox.accessProfiles.noLimit`) },
    { value: `off`, label: t(`sandbox.accessProfiles.unavailable`) },
]);
const files = computed(() => [
    { value: ``, label: t(`sandbox.accessProfiles.noLimit`) },
    ...([`none`, `read`, `write`] as const).map((value) => ({ value, label: t(`sandbox.accessProfiles.files_${value}`) })),
]);
const setFiles = (value: string | undefined): void =>
    emit(`change`, { ...tools, files: value === `none` || value === `read` || value === `write` ? value : undefined });
</script>
<template>
    <div class="grid gap-3 sm:grid-cols-2">
        <label class="flex items-center justify-between gap-3 text-sm"
            ><span>{{ t(`sandbox.accessProfiles.files`) }}</span
            ><Picker
                :model-value="tools?.files ?? ``"
                :options="files"
                :disabled="disabled"
                :aria-label="t(`sandbox.accessProfiles.files`)"
                variant="input"
                @update:model-value="setFiles"
        /></label>
        <label v-for="shelf in CEILING_SWITCHES" :key="shelf" class="flex items-center justify-between gap-3 text-sm"
            ><span>{{ t(`sandbox.accessProfiles.${shelf}`) }}</span
            ><Picker
                :model-value="tools?.[shelf] === false ? `off` : ``"
                :options="switches"
                :disabled="disabled"
                :aria-label="t(`sandbox.accessProfiles.${shelf}`)"
                variant="input"
                @update:model-value="emit(`change`, { ...tools, [shelf]: $event === `off` ? false : undefined })"
        /></label>
    </div>
</template>

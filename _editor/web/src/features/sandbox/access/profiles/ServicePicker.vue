<script setup lang="ts">
import { Picker } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useServices } from "./useServices";
const { allowOwner = true } = defineProps<{ allowOwner?: boolean }>();
const model = defineModel<string>();
const t = useT();
const { available, services } = useServices();
const options = computed(() => [
    ...(allowOwner ? [{ value: ``, label: t(`sandbox.accessServices.owner`) }] : []),
    ...services.value.map((service) => ({ value: service.id, label: service.label ?? service.id })),
]);
</script>
<template>
    <Picker
        v-if="available"
        :model-value="model ?? ``"
        :options="options"
        :aria-label="t(`sandbox.accessServices.runsAs`)"
        :header="t(`sandbox.accessServices.runsAs`)"
        variant="input"
        @update:model-value="model = $event || undefined"
    />
</template>

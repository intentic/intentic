<script setup lang="ts">
import { mintedVariants } from "@intentic/sandbox-contract";
import { SegmentedControl } from "@intentic/ui";
import { computed } from "vue";

// Undefined shows the first estate, which is also what the daemon takes for a sign-in that names none.
const estate = defineModel<string | undefined>({ required: true });
const { provider, label } = defineProps<{ provider: string; label: string }>();

const variants = computed(() => mintedVariants(provider) ?? []);
const chosen = computed<string>({
    get: () => estate.value ?? variants.value[0]?.id ?? ``,
    set: (value) => {
        estate.value = value;
    },
});
</script>

<template>
    <SegmentedControl
        v-model="chosen"
        size="xs"
        wrap
        :options="variants.map((variant) => ({ label: variant.label, value: variant.id }))"
        :aria-label="label"
    />
</template>

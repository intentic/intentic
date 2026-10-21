<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { DetailLevel } from "./detailLevel";

// The Simple | Advanced pair at the end of a Tools section's header line: the same section drawn two ways, so pills
// rather than tabs (SegmentedControl's own rule). `label` names the section it switches, for a screen reader that meets
// six of these on one page.

const t = useT();
const level = defineModel<DetailLevel>({ required: true });
const { label } = defineProps<{ label: string }>();

const OPTIONS = computed(
    () =>
        [
            { label: t(`sandbox.agentTools.simple`), value: `simple` },
            { label: t(`sandbox.agentTools.advanced`), value: `advanced` },
        ] as const,
);
</script>

<template>
    <SegmentedControl v-model="level" :options="OPTIONS" size="xs" :aria-label="t(`sandbox.agentTools.detailOf`, { section: label })" />
</template>

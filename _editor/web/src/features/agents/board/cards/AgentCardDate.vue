<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { sandboxNow } from "../../fleet/sandboxClock";
import { timeAgo } from "@intentic/ui";

// Only the date text follows this shared minute clock, never the card/row around it. A computed label also leaves
// hour/day/date readouts untouched while their wording stays the same. Mounted only while the date is shown.
const props = defineProps<{ at: number; archived?: boolean }>();
const t = useT();
const now = useNow(true, 60_000);
const label = computed(() => {
    const age = timeAgo(props.at, { now: sandboxNow(now.value), days: true });
    return props.archived ? t(`agents.agentCard.archived`, { archivedAt: age }) : age;
});
</script>

<template>{{ label }}</template>

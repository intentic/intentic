<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { relativeTime } from "../../../chat/models/catalog";
import { sandboxNow } from "../../fleet/sandboxClock";

// Only the date text follows this shared minute clock, never the card/row around it. A computed label also leaves
// hour/day/date readouts untouched while their wording stays the same. Mounted only while the date is shown.
const props = defineProps<{ at: number; archived?: boolean }>();
const t = useT();
const now = useNow(true, 60_000);
const label = computed(() => {
    const age = relativeTime(props.at, sandboxNow(now.value));
    return props.archived ? t(`agents.agentCard.archived`, { archivedAt: age }) : age;
});
</script>

<template>{{ label }}</template>

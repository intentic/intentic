<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { sandboxNow } from "../../models/agent-status/sandboxClock";
import { formatAge } from "@intentic/ui";

// Only the date text follows this shared minute clock, never the card/row around it. A computed label also leaves
// hour/day/date readouts untouched while their wording stays the same. Mounted only while the date is shown.
// An age with no "ago" ("26m", "3d", "Oct 20"): the slot it sits in already says it is a time since.
const props = defineProps<{ at: number }>();
const now = useNow(true, 60_000);
const label = computed(() => formatAge(props.at, sandboxNow(now.value)));
</script>

<template>{{ label }}</template>

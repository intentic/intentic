<script setup lang="ts">
import { computed } from "vue";
import { createWidget, type Widget } from "./widget.js";

const props = defineProps<{ names: string[] }>();

const widgets = computed<Widget[]>(() => props.names.map((name) => createWidget(name)));

// Branchy on purpose: the only decision points in the fixture, so `hotspots` has something to rank.
const labelOf = (widget: Widget): string => {
    if (widget.name === "") {
        return "(unnamed)";
    }
    for (const prefix of ["alpha", "beta"]) {
        if (widget.name.startsWith(prefix) && prefix.length > 3) {
            return prefix.toUpperCase();
        }
    }
    return widget.name.toUpperCase();
};
</script>

<template>
    <ul>
        <li v-for="widget in widgets" :key="widget.name">{{ labelOf(widget) }}</li>
    </ul>
</template>

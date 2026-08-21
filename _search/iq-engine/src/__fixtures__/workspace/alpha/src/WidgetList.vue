<script setup lang="ts">
import { computed } from "vue";
import { createWidget, type Widget } from "./widget.js";

// Destructured across lines on purpose, and the reason is a real failure: a declarator's name field holds the
// PATTERN here, not an identifier, so an extractor that reads it as a name records a multi-line "symbol", and
// the graph stage then hands that to ripgrep as a search pattern, which refuses the newline and killed whole
// queries. Every `.vue` in the real workspace is written this way; the fixture had the one shape that isn't.
const { names, heading = `Widgets` } = defineProps<{ names: string[]; heading?: string }>();

const widgets = computed<Widget[]>(() => names.map((name) => createWidget(name)));

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
    <ul :aria-label="heading">
        <li v-for="widget in widgets" :key="widget.name">{{ labelOf(widget) }}</li>
    </ul>
</template>

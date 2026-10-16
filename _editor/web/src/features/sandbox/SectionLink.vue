<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { RouterLink, type RouteLocationRaw } from "vue-router";

// One line saying where something related is kept, with the way there: a setting's record in Activity, the records'
// settings on their own page, a measure's home. Quiet, since it is a signpost and not a control; the sentence says what
// is there, the link names the place.
const { text, to, label } = defineProps<{ text: string; to: RouteLocationRaw; label: string }>();
</script>

<template>
    <p class="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
        {{ text }}
        <RouterLink :to="to" :class="ui.textButton()">{{ label }}<Icon name="arrow-right" class="text-2xs" /></RouterLink>
    </p>
</template>

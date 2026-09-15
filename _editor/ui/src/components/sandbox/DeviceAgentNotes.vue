<!-- What a device's agent wants, and why it has no buttons: one column of short lines, a notice where there's an errand. -->
<script setup lang="ts">
import Notice from "../feedback/Notice.vue";
import Icon from "../primitives/Icon.vue";
import type { AgentNote } from "./deviceAgent.js";

// One list, not two blocks that happen to sit together: the errands and the reason the controls are missing
// read as one column.
defineProps<{ notes: readonly AgentNote[] }>();
</script>

<template>
    <div class="flex flex-col gap-2 empty:hidden">
        <template v-for="note in notes" :key="note.text">
            <Notice v-if="note.tone" v-tooltip.top="note.hint" :tone="note.tone">{{ note.text }}</Notice>
            <p v-else v-tooltip.top="note.hint" class="flex w-fit items-center gap-1.5 text-xs text-muted">
                <Icon v-if="note.icon" :name="note.icon" aria-hidden="true" class="shrink-0" />{{ note.text }}
            </p>
        </template>
    </div>
</template>

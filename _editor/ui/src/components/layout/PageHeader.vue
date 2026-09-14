<!-- The standard title block for a rail panel: h1, optional `#info` (hint/badge), optional `#actions`, and a muted description line. -->
<script setup lang="ts">
import { ui } from "../../lib/ui.js";
import { usePageBack } from "./pageBack.js";

defineProps<{ title: string; description?: string }>();

const back = usePageBack();
</script>

<template>
    <header :class="description ? 'mb-6' : 'mb-4'">
        <div class="flex items-center justify-between gap-3">
<!-- THE TITLE CLUSTER TAKES THE ROW'S LEFTOVER WIDTH, not its own content's. -->
            <div class="flex min-w-0 flex-1 items-center gap-2">
<!-- A button rather than a link: where it goes is history, not an address (see pageBack.ts). -->
                <button v-if="back" type="button" :class="ui.iconButton(`-ml-1.5 h-8 w-8 shrink-0`)" :aria-label="back.label" @click="back.go()">
                    <Icon name="arrow-left" class="text-base" />
                </button>
                <h1 class="min-w-0 truncate text-2xl font-semibold">{{ title }}</h1>
                <slot name="info" />
            </div>
            <div v-if="$slots['actions']" class="flex shrink-0 items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <p v-if="(description !== undefined && description !== ``) || $slots['description']" class="mt-1 text-sm text-muted">
            <slot name="description">{{ description }}</slot>
        </p>
    </header>
</template>

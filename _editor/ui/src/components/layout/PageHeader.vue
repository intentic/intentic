<!-- The standard title block for a rail panel: h1, optional `#info` (hint/badge), optional `#actions`, and a muted description line. -->
<script setup lang="ts">
import { ui } from "../../lib/ui.js";
import { usePageBack } from "./pageBack.js";

defineProps<{ title: string; description?: string }>();

const back = usePageBack();
</script>

<template>
    <!-- `ui-page-header` is how the desktop app's window buttons find the row that meets their corner (web's workbench/window/controlsReserve.ts). -->
    <header class="ui-page-header" :class="description ? 'mb-6' : 'mb-4'">
        <!-- THE TITLE OUTRANKS THE ACTIONS: when both no longer fit one line, the actions take a line of their own under it
             rather than cutting the page's name down to "Workfl…", which on a phone was every page with a button. -->
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <!-- THE TITLE CLUSTER TAKES THE ROW'S LEFTOVER WIDTH, and asks for its own content's first (`flex-auto`, a basis of its content), which is what sends the actions to the next line instead of squeezing the title. It wraps too, for the same reason: an `#info` that no longer fits beside the name goes under it. -->
            <div class="flex min-w-0 flex-auto flex-wrap items-center gap-x-2 gap-y-1">
                <!-- The way back and the name never part: a title longer than the whole row truncates here, beside its arrow. -->
                <div class="flex min-w-0 max-w-full items-center gap-2">
                    <!-- A button rather than a link: where it goes is history, not an address (see pageBack.ts). -->
                    <button v-if="back" type="button" :class="ui.iconButton(`-ml-1.5 h-8 w-8 shrink-0`)" :aria-label="back.label" @click="back.go()">
                        <Icon name="arrow-left" class="text-base" />
                    </button>
                    <h1 class="min-w-0 truncate text-2xl font-semibold">{{ title }}</h1>
                </div>
                <slot name="info" />
            </div>
            <!-- `ml-auto` keeps a wrapped cluster on the right edge, where the actions stand when they share the title's line. -->
            <div v-if="$slots['actions']" class="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
                <slot name="actions" />
            </div>
        </div>
        <p v-if="(description !== undefined && description !== ``) || $slots['description']" class="mt-1 text-sm text-muted">
            <slot name="description">{{ description }}</slot>
        </p>
    </header>
</template>

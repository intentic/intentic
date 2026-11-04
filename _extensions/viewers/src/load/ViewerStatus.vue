<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { t } from "../i18n.js";

/* A viewer's spinner and its error, and in their place, once the load settled cleanly, its own content (the slot).
   `overlay` is for a viewer that draws into an element of its own: that element has to stay mounted under the
   spinner, so the states cover it rather than replace it. `stale` is a refresh that could not be drawn over a rendering
   that could (useViewerLoad): the rendering stays, and a corner note says it is an earlier version. */

const { loading, error, overlay = false, stale = false } = defineProps<{ loading: boolean; error?: string; overlay?: boolean; stale?: boolean }>();
</script>

<template>
    <div v-if="loading" data-print-loading="true" class="flex items-center justify-center text-muted" :class="overlay ? `absolute inset-0 bg-canvas` : `h-full`">
        <Icon name="spinner" class="text-xl" spin />
    </div>
    <div
        v-else-if="error !== undefined"
        data-print-error="true"
        class="flex flex-col items-center justify-center gap-2 px-6 text-center"
        :class="overlay ? `absolute inset-0 bg-canvas` : `h-full`"
    >
        <Icon name="exclamation-triangle" class="text-3xl text-danger" />
        <p class="text-sm text-danger">{{ error }}</p>
    </div>
    <slot v-else></slot>
    <span
        v-if="stale && !loading && error === undefined"
        role="status"
        class="pointer-events-none absolute right-3 top-2 z-10 rounded-md bg-card/90 px-2 py-0.5 text-2xs text-muted shadow-sm"
        :title="t(`common.staleRendering`)"
        >{{ t(`common.staleRenderingShort`) }}</span
    >
</template>

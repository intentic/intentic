<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";

/* A viewer's spinner and its error, and in their place, once the load settled cleanly, its own content (the slot).
   `overlay` is for a viewer that draws into an element of its own: that element has to stay mounted under the
   spinner, so the states cover it rather than replace it. */

const { loading, error, overlay = false } = defineProps<{ loading: boolean; error?: string; overlay?: boolean }>();
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
</template>

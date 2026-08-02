<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { computed } from "vue";
import { formatBytes } from "@intentic/ui";

/* The non-renderable states of the viewer: a binary file (no inline preview), a file too large to preview, or
 * an empty file. Binary/too-large offer a Download (the dispatcher fetches the bytes and saves them). */

const { mode, size } = defineProps<{ mode: `binary` | `too-large` | `empty`; size?: number }>();
const emit = defineEmits<{ download: [] }>();

const icon = computed<IconName>(() => (mode === `empty` ? `file` : mode === `too-large` ? `exclamation-circle` : `box`));

const message = computed(() => {
    if (mode === `empty`) {
        return `This file is empty.`;
    }
    if (mode === `too-large`) {
        const label = formatBytes(size);
        return label ? `This file is ${label} — too large to preview here.` : `This file is too large to preview here.`;
    }
    return `Preview isn't available for this file type.`;
});
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Icon :name="icon" class="text-4xl text-subtle" />
        <p class="max-w-sm text-sm text-muted">{{ message }}</p>
        <button
            v-if="mode !== 'empty'"
            type="button"
            class="mt-1 inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-content transition-colors hover:border-line-strong hover:bg-overlay"
            @click="emit('download')"
        >
            <Icon name="download" class="text-xs" />
            Download
        </button>
    </div>
</template>

<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { computed } from "vue";
import { Button, EmptyState, formatBytes } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The non-renderable states of the viewer: a binary file (no inline preview), a file too large to preview, or an empty file. */

const { mode, size } = defineProps<{ mode: `binary` | `too-large` | `empty`; size?: number }>();
const emit = defineEmits<{ download: [] }>();

const icon = computed<IconName>(() => (mode === `empty` ? `file` : mode === `too-large` ? `exclamation-circle` : `box`));

const message = computed(() => {
    if (mode === `empty`) {
        return t(`workspace.fileUnsupported.empty`);
    }
    if (mode === `too-large`) {
        const label = formatBytes(size);
        return label ? t(`workspace.fileUnsupported.tooLargeSized`, { size: label }) : t(`workspace.fileUnsupported.tooLarge`);
    }
    return t(`workspace.fileUnsupported.noPreview`);
});
</script>

<template>
    <EmptyState :icon="icon" :title="message" class="h-full">
        <template v-if="mode !== 'empty'" #actions>
            <Button severity="secondary" @click="emit('download')">
                <Icon name="download" class="text-xs" />
                {{ t(`ui.action.download`) }}
            </Button>
        </template>
    </EmptyState>
</template>

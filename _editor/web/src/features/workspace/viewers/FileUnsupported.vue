<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { computed } from "vue";
import { Button, EmptyState, formatBytes } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The states of the viewer that show no file (yet): a binary file (no inline preview), a file too large for the server
   it is on to hand over (one from before any size was served), a large file a viewer would read whole into the tab
   (opened on the reader's word), or an empty file. */

const { mode, size } = defineProps<{ mode: `binary` | `too-large` | `large` | `empty`; size?: number }>();
const emit = defineEmits<{ download: []; open: [] }>();

const icon = computed<IconName>(() => (mode === `empty` ? `file` : mode === `too-large` ? `exclamation-circle` : mode === `large` ? `eye` : `box`));

const message = computed(() => {
    if (mode === `empty`) {
        return t(`workspace.fileUnsupported.empty`);
    }
    if (mode === `large`) {
        return t(`workspace.fileUnsupported.largeSized`, { size: formatBytes(size) });
    }
    if (mode === `too-large`) {
        const label = formatBytes(size);
        return label ? t(`workspace.fileUnsupported.tooLargeSized`, { size: label }) : t(`workspace.fileUnsupported.tooLarge`);
    }
    return t(`workspace.fileUnsupported.noPreview`);
});
</script>

<template>
    <EmptyState :icon="icon" :title="message" :line="mode === 'large' ? t(`workspace.fileUnsupported.largeLine`) : undefined" class="h-full">
        <template v-if="mode !== 'empty'" #actions>
            <Button v-if="mode === 'large'" tier="loud" @click="emit('open')">
                <Icon name="eye" class="text-xs" />
                {{ t(`workspace.fileUnsupported.openHere`) }}
            </Button>
            <Button tier="boring" @click="emit('download')">
                <Icon name="download" class="text-xs" />
                {{ t(`ui.action.download`) }}
            </Button>
        </template>
    </EmptyState>
</template>

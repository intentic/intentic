<script setup lang="ts">
import { AddressField, Button, Icon, Popover } from "@intentic/extension-ui";
import { ref } from "vue";
import { t } from "./i18n.js";

/* Share a live preview: the one-click viral primitive. */

const { url, label } = defineProps<{ url: string; label?: string }>();

const popover = ref<InstanceType<typeof Popover> | null>(null);
const toggle = (event: Event): void => popover.value?.toggle(event);
</script>

<template>
    <Button :label="label ?? t(`sharePreview.share`)" size="small" severity="secondary" @click="toggle">
        <template #icon><Icon name="link" /></template>
    </Button>
    <Popover ref="popover">
        <div class="flex w-72 flex-col gap-2 p-1">
            <p class="text-sm font-medium text-content">{{ t(`sharePreview.shareLivePreview`) }}</p>
            <!-- The field carries copy and open itself, so the link and what to do with it sit on one line. -->
            <AddressField :value="url" openable :copy-label="t(`sharePreview.copyLink`)" :open-label="t(`sharePreview.openPreviewInNew`)" />
            <span class="inline-flex items-center gap-1 text-2xs text-subtle">
                <Icon name="globe" class="text-2xs" /> {{ t(`sharePreview.anyoneLinkOpen`) }}
            </span>
        </div>
    </Popover>
</template>

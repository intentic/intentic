<script setup lang="ts">
import { Button, CopyButton, Icon, Popover } from "@intentic/extension-ui";
import { ref } from "vue";
import { t } from "./i18n.js";

/* Share a live preview: the one-click viral primitive. */

const { url, label = `Share` } = defineProps<{ url: string; label?: string }>();

const popover = ref<InstanceType<typeof Popover> | null>(null);
const toggle = (event: Event): void => popover.value?.toggle(event);
</script>

<template>
    <Button :label="label" size="small" severity="secondary" @click="toggle">
        <template #icon><Icon name="link" /></template>
    </Button>
    <Popover ref="popover">
        <div class="flex w-72 flex-col gap-2 p-1">
            <p class="text-sm font-medium text-content">{{ t(`sharePreview.shareLivePreview`) }}</p>
            <div class="flex items-center gap-2 rounded-md border border-line bg-canvas px-2 py-1.5">
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" :title="url">{{ url }}</span>
                <a
                    :href="url"
                    target="_blank"
                    rel="noopener"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-subtle hover:bg-overlay hover:text-content"
                    :aria-label="t(`sharePreview.openPreviewInNew`)"
                    v-tooltip.bottom="t(`sharePreview.openInNewTab`)"
                >
                    <Icon name="external-link" class="text-2xs" />
                </a>
            </div>
            <div class="flex items-center justify-between gap-2">
                <CopyButton :text="url" :label="t(`sharePreview.copyLink`)" />
                <span class="inline-flex items-center gap-1 text-2xs text-subtle">
                    <Icon name="globe" class="text-2xs" /> {{ t(`sharePreview.anyoneLinkOpen`) }}
                </span>
            </div>
        </div>
    </Popover>
</template>

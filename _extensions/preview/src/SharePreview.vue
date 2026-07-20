<script setup lang="ts">
import { Button, CopyButton, Icon, Popover } from "@intentic/extension-ui";
import { ref } from "vue";

/* Share a live preview: the one-click viral primitive. A running panel/forwarded port already answers at a PUBLIC
 * `preview-*` / `port-*` hostname (the preview proxy has no auth in front of it), so its URL is a working, sendable
 * link the instant it's up — every shared URL is a live demo of the app and an implicit invite back to Intentic.
 * This surfaces that link with a copy action AND says plainly that it's public, so "shareable" never reads as
 * "leaked". Presentational: the caller passes the already-resolved public `url`. */

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
            <p class="text-sm font-medium text-content">Share this live preview</p>
            <div class="flex items-center gap-2 rounded-md border border-line bg-canvas px-2 py-1.5">
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" :title="url">{{ url }}</span>
                <a
                    :href="url"
                    target="_blank"
                    rel="noopener"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-subtle hover:bg-overlay hover:text-content"
                    aria-label="Open the preview in a new tab"
                    v-tooltip.bottom="'Open in new tab'"
                >
                    <Icon name="external-link" class="text-2xs" />
                </a>
            </div>
            <div class="flex items-center justify-between gap-2">
                <CopyButton :text="url" label="Copy link" />
                <span class="inline-flex items-center gap-1 text-2xs text-subtle">
                    <Icon name="globe" class="text-2xs" /> Anyone with this link can open it
                </span>
            </div>
        </div>
    </Popover>
</template>

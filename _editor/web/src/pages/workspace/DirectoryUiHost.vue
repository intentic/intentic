<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { createDirectoryUiBridge, loadDirectoryUi } from "../../composables/workspace/useDirectoryUi";

/* Renders a directory's own UI (its `.intentic/ui/index.html`) inside a locked-down iframe. The document is read
 * through the authed daemon file route and injected as `srcdoc`, so the frame is an opaque origin with NO access
 * to the parent DOM, cookies, or the sandbox tokens — `sandbox="allow-scripts"` alone (no allow-same-origin).
 * It reaches its sandbox only through the postMessage bridge's allowlist (directoryUiVerbs.ts). No new-tab escape
 * hatch: the raw source is always visible in the file tree. */

const props = defineProps<{ dir: string }>();

const html = shallowRef<string | undefined>(undefined);
const loading = ref(true);
const iframe = ref<HTMLIFrameElement>();
let detach: (() => void) | undefined;

// Reload when the directory changes; the bridge is re-attached per iframe render so a stale frame's window can't
// keep answering.
watch(
    () => props.dir,
    async (dir) => {
        detach?.();
        detach = undefined;
        loading.value = true;
        html.value = await loadDirectoryUi(dir);
        loading.value = false;
    },
    { immediate: true },
);

const onLoad = (): void => {
    detach?.();
    if (iframe.value !== undefined) {
        detach = createDirectoryUiBridge(iframe.value);
    }
};
onBeforeUnmount(() => detach?.());
</script>

<template>
    <div class="flex h-full min-h-0 flex-col bg-canvas">
        <div v-if="loading" class="flex flex-1 items-center justify-center text-muted">
            <Icon name="spinner" class="text-lg" spin />
        </div>
        <div v-else-if="html === undefined" class="flex flex-1 flex-col items-center justify-center gap-1 text-muted">
            <Icon name="exclamation-triangle" class="text-warning" />
            <span class="text-xs">This directory's UI couldn't be loaded.</span>
        </div>
        <iframe
            v-else
            ref="iframe"
            :srcdoc="html"
            sandbox="allow-scripts"
            :title="`${dir || 'workspace'} UI`"
            class="min-h-0 w-full flex-1 border-0 bg-white"
            @load="onLoad"
        ></iframe>
    </div>
</template>

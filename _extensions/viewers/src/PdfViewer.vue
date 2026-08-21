<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { onBeforeUnmount, ref, watch } from "vue";

/* PDF preview: the browser's own PDF plugin, via <object>. No renderer is bundled, every browser this app
 * supports ships one, and pdf.js would add a megabyte to do slightly worse than the thing already installed.
 *
 * <object> gives a fallback for the browsers that don't (an old mobile WebView, a stripped Chromium): its
 * children render only when the plugin declines the data, so the download offer below is not a state this
 * component has to detect: it is what the element falls through to. The download itself is the host's, which
 * is what keeps this component free of daemon credentials. */

const { blob } = defineProps<{ blob: Blob }>();
defineEmits<{ download: [] }>();

const url = ref<string>();

const revoke = (): void => {
    if (url.value !== undefined) {
        URL.revokeObjectURL(url.value);
    }
};

watch(
    () => blob,
    (next) => {
        revoke();
        url.value = URL.createObjectURL(next);
    },
    { immediate: true },
);
onBeforeUnmount(revoke);
</script>

<template>
    <object v-if="url" :data="url" type="application/pdf" class="h-full w-full">
        <div class="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
            <p class="text-sm">This PDF can't be displayed inline.</p>
            <button
                type="button"
                class="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-content hover:bg-overlay"
                @click="$emit(`download`)"
            >
                <Icon name="download" class="text-xs" /> Download
            </button>
        </div>
    </object>
</template>

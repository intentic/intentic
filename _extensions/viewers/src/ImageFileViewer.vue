<script setup lang="ts">
import { ImageView } from "@intentic/extension-ui";
import { onBeforeUnmount, ref, watch } from "vue";

/* Image preview: the kit's ImageView (zoom, pan, transparency checkerboard) pointed at the bytes the host
 * fetched. The picture itself is drawn by the same component the binary-diff panes use, so an image looks and
 * behaves identically wherever it appears in the app.
 *
 * The blob → object URL step is this component's because the URL's LIFETIME is: the host hands over bytes and
 * stops caring, so whoever mints the URL has to revoke it. Doing it on the watcher and on unmount keeps a walk
 * through a folder of screenshots from leaking one URL per file. */

const { blob } = defineProps<{ blob: Blob }>();

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
    <ImageView v-if="url" :src="url" />
</template>

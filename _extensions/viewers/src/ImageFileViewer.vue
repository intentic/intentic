<script setup lang="ts">
import { ImageView } from "@intentic/extension-ui";
import { onBeforeUnmount, ref, watch } from "vue";

/* Image preview: the kit's ImageView (zoom, pan, transparency checkerboard) pointed at the bytes the host fetched. */

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

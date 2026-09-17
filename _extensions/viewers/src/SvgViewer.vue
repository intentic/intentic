<script setup lang="ts">
import { Code, ImageView, SegmentedControl } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { t } from "./i18n.js";

/* SVG viewer: the picture by default, with a Source toggle for the markup. */

const { text } = defineProps<{ text: string }>();

const view = ref<`preview` | `source`>(`preview`);
const url = ref<string>();

const revoke = (): void => {
    if (url.value !== undefined) {
        URL.revokeObjectURL(url.value);
    }
};

watch(
    () => text,
    (next) => {
        revoke();
        url.value = URL.createObjectURL(new Blob([next], { type: `image/svg+xml` }));
    },
    { immediate: true },
);
onBeforeUnmount(revoke);

const options = computed(() => [
    { label: t(`svgViewer.preview`), value: `preview` as const },
    { label: t(`svgViewer.source`), value: `source` as const },
]);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center border-b border-line-subtle px-2 py-1.5">
            <SegmentedControl v-model="view" :options="options" />
        </div>
        <div class="min-h-0 flex-1">
            <ImageView v-if="view === 'preview' && url" :src="url" />
            <Code v-else-if="view === 'source'" :code="text" lang="xml" class="h-full overflow-auto" />
        </div>
    </div>
</template>

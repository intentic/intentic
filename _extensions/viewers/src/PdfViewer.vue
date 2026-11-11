<script setup lang="ts">
import { Button, Icon } from "@intentic/extension-ui";
import { onBeforeUnmount, ref, watch } from "vue";
import { t } from "./i18n.js";

/* PDF preview: the browser's own PDF plugin, via <object>. The hosted editor's CSP lets an <object> and a frame load
   blob: URLs for this (nginx.conf), so the blob is typed as a PDF here, whatever type it arrived with: what the page
   embeds is only ever handed to the PDF viewer, never rendered as a document of the editor's own origin. */

const { blob } = defineProps<{ blob: Blob }>();
defineEmits<{ download: [] }>();

const PDF = `application/pdf`;
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
        url.value = URL.createObjectURL(next.type === PDF ? next : new Blob([next], { type: PDF }));
    },
    { immediate: true },
);
onBeforeUnmount(revoke);
</script>

<template>
    <object v-if="url" :data="url" type="application/pdf" class="h-full w-full">
        <div class="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
            <p class="text-sm">{{ t(`pdfViewer.pdfCantDisplayedInline`) }}</p>
            <Button tier="boring" @click="$emit(`download`)"> <Icon name="download" class="text-xs" /> {{ t(`pdfViewer.download`) }} </Button>
        </div>
    </object>
</template>

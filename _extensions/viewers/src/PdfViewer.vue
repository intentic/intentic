<script setup lang="ts">
import { Button, Icon } from "@intentic/extension-ui";
import { onBeforeUnmount, ref, watch } from "vue";

/* PDF preview: the browser's own PDF plugin, via <object>. */

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
            <Button severity="secondary" @click="$emit(`download`)"> <Icon name="download" class="text-xs" /> Download </Button>
        </div>
    </object>
</template>

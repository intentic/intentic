<script setup lang="ts">
import { onErrorCaptured, shallowRef } from "vue";
import { errorMessage } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* Contains one extension view's render/lifecycle errors so a broken extension shows an inline card instead of unmounting the shell. */

const { extensionId } = defineProps<{ extensionId: string }>();
const error = shallowRef<unknown>();
onErrorCaptured((captured) => {
    error.value = captured;
    return false;
});
</script>

<template>
    <div v-if="error !== undefined" class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted">
        <p>{{ t(`views.extensionErrorBoundary.extensionCrashedRenderingView`, { extensionId }) }}</p>
        <p class="text-xs">{{ errorMessage(error, String(error)) }}</p>
    </div>
    <slot v-else />
</template>

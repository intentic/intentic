<script setup lang="ts">
import { EmptyState } from "@intentic/ui";
import { onErrorCaptured, shallowRef } from "vue";
import { messageOr } from "@intentic/ui/async";
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
    <EmptyState
        v-if="error !== undefined"
        tone="danger"
        :title="t(`views.extensionErrorBoundary.extensionCrashedRenderingView`, { extensionId })"
        :line="messageOr(error, String(error))"
        class="h-full"
    />
    <slot v-else />
</template>

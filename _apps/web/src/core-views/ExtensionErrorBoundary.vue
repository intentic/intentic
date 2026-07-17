<script setup lang="ts">
import { onErrorCaptured, shallowRef } from "vue";

/* Contains one extension view's render/lifecycle errors so a broken extension shows an inline card instead of
 * unmounting the shell. Errors stop here (return false) — nothing above this boundary can recover a foreign
 * view. The host keys this component per activation, so navigating away and back retries a crashed view. */

const { extensionId } = defineProps<{ extensionId: string }>();
const error = shallowRef<unknown>();
onErrorCaptured((captured) => {
    error.value = captured;
    return false;
});
</script>

<template>
    <div v-if="error !== undefined" class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted">
        <p>The "{{ extensionId }}" extension crashed rendering this view.</p>
        <p class="text-xs">{{ error instanceof Error ? error.message : String(error) }}</p>
    </div>
    <slot v-else />
</template>

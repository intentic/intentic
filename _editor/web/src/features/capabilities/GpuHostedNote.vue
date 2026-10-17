<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

// On a hosted sandbox the Docker tile drops its GPU switch (capabilityFieldAvailable), so this says why, and clears a
// GPU request an earlier save carried, which the hosted machine would otherwise keep refusing.
const gpu = defineModel<string | undefined>({ required: true });
const t = useT();
</script>

<template>
    <p class="text-2xs text-subtle">
        {{ t(`capabilities.capabilitySubmit.gpuHosted`) }}
        <button v-if="gpu === 'on'" type="button" class="text-link" @click="gpu = 'off'">
            {{ t(`capabilities.capabilitySubmit.gpuDisable`) }}
        </button>
    </p>
</template>

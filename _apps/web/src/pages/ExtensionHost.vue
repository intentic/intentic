<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { usePanels } from "../composables/extensions/usePanels";
import { detectActivations } from "../core-views/registry";
import ExtensionView from "../core-views/ExtensionView.vue";

/* Hosts one extension activation (/ext/:ext/:key): re-runs the registry's detection over the live repo facts
 * and capability manifest, and renders the matched activation via ExtensionView. An activation that no longer
 * detects (repo deleted, marker removed, capability disconnected) shows a plain empty state — its rail tile
 * disappears on the same poll. */

const route = useRoute();
const { panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();

const found = computed(() =>
    detectActivations(panels.value, capabilities.value).find(
        ({ extension, activation }) => extension.id === String(route.params[`ext`]) && activation.key === String(route.params[`key`]),
    ),
);
</script>

<template>
    <ExtensionView v-if="found" :extension="found.extension" :activation="found.activation" />
    <div v-else-if="!isLoading" class="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
        <p>Nothing here — this view's content is no longer in the workspace.</p>
    </div>
</template>

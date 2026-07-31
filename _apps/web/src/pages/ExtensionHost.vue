<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-api";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useExtensions } from "../composables/extensions/useExtensions";
import { usePanels } from "../composables/extensions/usePanels";
import { detectActivations } from "../core-views/registry";
import ExtensionView from "../core-views/ExtensionView.vue";

/* Hosts one extension activation (/ext/:ext/:key?): re-runs the registry's detection over the live repo facts
 * and capability manifest, and renders the matched activation via ExtensionView. An activation that no longer
 * detects (repo deleted, marker removed, capability disconnected) shows a plain empty state — its rail tile
 * disappears on the same poll. A switched-off extension's views are disposed the same way, so the two are
 * indistinguishable from the registry alone: name that case from the extension list rather than telling
 * someone their content left the workspace when they turned it off themselves (a bookmark still resolves here). */

const route = useRoute();
const { panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();
const { extensions } = useExtensions();

const disabledOwner = computed(() =>
    extensions.value.find(
        (extension) =>
            !extension.enabled && (extension.manifest.contributes?.views ?? []).some((view) => view.id === String(route.params[`ext`])),
    ),
);

const found = computed(() => {
    const ext = String(route.params[`ext`]);
    // A singleton view links to /ext/<id> with no key segment (extensionPath drops the redundant key === id);
    // resolve the absent segment back to the view id, the same value the builder collapsed.
    const key = route.params[`key`] ? String(route.params[`key`]) : ext;
    return detectActivations(panels.value, capabilities.value).find(({ extension, activation }) => extension.id === ext && activation.key === key);
});
</script>

<template>
    <ExtensionView v-if="found" :extension="found.extension" :activation="found.activation" />
    <div v-else-if="disabledOwner" class="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
        <p>{{ extensionIdOf(disabledOwner.manifest) }} is switched off.</p>
        <RouterLink to="/sandbox/extensions" class="text-link hover:underline">Turn it back on in Sandbox → Extensions</RouterLink>
    </div>
    <div v-else-if="!isLoading" class="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
        <p>Nothing here — this view's content is no longer in the workspace.</p>
    </div>
</template>

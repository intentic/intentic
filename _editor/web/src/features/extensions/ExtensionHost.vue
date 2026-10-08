<script setup lang="ts">
import { Button, EmptyState } from "@intentic/ui";
import { extensionIdOf } from "@intentic/extension-manifest";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { useExtensions } from "./useExtensions";
import { usePanels } from "./usePanels";
import { detectActivations } from "../../workbench/views/registry";
import ExtensionView from "../../core-views/ExtensionView.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* Hosts one extension activation (/ext/:ext/:key?): re-runs the registry's detection over the live repo facts and capability manifest. */

const route = useRoute();
const { panels, isLoading } = usePanels();
const { capabilities } = useCapabilities();
const { extensions } = useExtensions();

const disabledOwner = computed(() =>
    extensions.value.find(
        (extension) => !extension.enabled && (extension.manifest.contributes?.views ?? []).some((view) => view.id === String(route.params[`ext`])),
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
    <EmptyState
        v-else-if="disabledOwner"
        icon="extensions"
        :title="t(`extensions.extensionHost.switchedOff`, { manifest: extensionIdOf(disabledOwner.manifest) })"
        class="h-full"
    >
        <template #actions>
            <Button :as="RouterLink" to="/sandbox/extensions?view=installed" size="small" tier="boring" :label="t(`extensions.extensionHost.turnBackOnIn`)" />
        </template>
    </EmptyState>
    <EmptyState v-else-if="!isLoading" :title="t(`extensions.extensionHost.nothingHereViewsContent`)" class="h-full" />
</template>

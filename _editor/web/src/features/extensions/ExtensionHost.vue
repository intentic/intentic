<script setup lang="ts">
import { Button, EmptyState } from "@intentic/ui";
import { extensionIdOf } from "@intentic/extension-manifest";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useCapabilities } from "../../models/capabilities/useCapabilities";
import { useExtensions } from "../../models/extensions/useExtensions";
import { usePanels } from "../../models/extensions/usePanels";
import { detectActivations } from "../../workbench/views/registry";
import { extensionsLoaded } from "../../workbench/views/extensionStatuses";
import ExtensionView from "../../core-views/ExtensionView.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* Hosts one extension activation (/ext/:ext/:key?): re-runs the registry's detection over the live repo facts and capability manifest. */

const route = useRoute();
const { panels, settled: panelsSettled } = usePanels();
const { capabilities, settled: capabilitiesSettled } = useCapabilities();
const { extensions } = useExtensions();

const ext = computed(() => String(route.params[`ext`]));
// A singleton view links to /ext/<id> with no key segment (extensionPath drops the redundant key === id); resolve the
// absent segment back to the view id, the same value the builder collapsed.
const key = computed(() => (route.params[`key`] ? String(route.params[`key`]) : ext.value));

const disabledOwner = computed(() =>
    extensions.value.find((extension) => !extension.enabled && (extension.manifest.contributes?.views ?? []).some((view) => view.id === ext.value)),
);

const found = computed(() =>
    detectActivations(panels.value, capabilities.value).find(
        ({ extension, activation }) => extension.id === ext.value && activation.key === key.value,
    ),
);

// Until every extension has run and the repos and capabilities it detects from have answered, a view not found yet is
// only late: the rail's own test for a missing tile (ShellDesktop's railSettled), so this page never says "nothing
// here" about a view whose bundle is still on its way.
const settled = computed(() => extensionsLoaded.value && panelsSettled.value && capabilitiesSettled.value);
// Named from the address before the activation is found, the same name ExtensionView defaults to after, so the
// remembered page is drawn from the first frame of the wait to the view's own.
const imprint = computed(() => `ext:${ext.value}/${key.value}`);
</script>

<template>
    <!-- Mounted through the whole wait, found or not yet, so its placeholder is one wait rather than two that each
         restart their reveal delay. -->
    <ExtensionView
        v-if="found || (!settled && !disabledOwner)"
        :extension="found?.extension"
        :activation="found?.activation"
        :imprint="imprint"
        :waiting="!settled"
    />
    <EmptyState
        v-else-if="disabledOwner"
        icon="extensions"
        :title="t(`extensions.extensionHost.switchedOff`, { manifest: extensionIdOf(disabledOwner.manifest) })"
        class="h-full"
    >
        <template #actions>
            <Button
                :as="RouterLink"
                to="/sandbox/extensions?view=installed"
                size="small"
                tier="boring"
                :label="t(`extensions.extensionHost.turnBackOnIn`)"
            />
        </template>
    </EmptyState>
    <EmptyState v-else :title="t(`extensions.extensionHost.nothingHereViewsContent`)" class="h-full" />
</template>

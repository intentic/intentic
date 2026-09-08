<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { computed, ref } from "vue";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { usePanels } from "../../extensions/usePanels";
import { detectActivations } from "../../../core-views/registry";
import ExtensionView from "../../../core-views/ExtensionView.vue";

// In-tree management surface for a repo directory: renders whichever directory-surface extension views the
// repo activates, switching between them when there's more than one. Empty when the repo has no such markers.
// The dev-server preview lives in the rail's Preview area, not here.

const { dir } = defineProps<{ dir: string }>();
const { panels } = usePanels();
const { capabilities } = useCapabilities();

// One activation per directory-surface view, not per extension: an extension can register several (e.g. Apps +
// Dependencies).
const activations = computed(() =>
    detectActivations(panels.value, capabilities.value).filter(
        ({ extension, activation }) => extension.surface === `directory` && activation.repo === dir,
    ),
);

// Falls back to the first activation, so a single-panel directory needs no selection, and a vanished choice lands on
// what remains.
const activeId = ref<string>();
const active = computed(() => activations.value.find(({ extension }) => extension.id === activeId.value) ?? activations.value[0]);
const options = computed(() => activations.value.map(({ extension }) => ({ label: extension.label, value: extension.id })));
const selected = computed<string>({
    get: () => active.value?.extension.id ?? ``,
    set: (id) => (activeId.value = id),
});
</script>

<template>
    <div v-if="active" class="flex h-full min-h-0 flex-col">
        <div v-if="activations.length > 1" class="flex h-8 shrink-0 items-center border-b border-line px-1.5">
            <SegmentedControl v-model="selected" size="xs" :options="options" />
        </div>
        <div class="min-h-0 flex-1 overflow-auto scrollbar-thin">
            <ExtensionView :extension="active.extension" :activation="active.activation" />
        </div>
    </div>
</template>

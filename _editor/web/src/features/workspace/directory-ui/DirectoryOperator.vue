<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useDirectoryTabs } from "./useDirectoryTabs";
import ExtensionView from "../../../core-views/ExtensionView.vue";

// In-tree management surface for a repo directory: renders whichever directory-surface extension views the
// repo activates (directoryTabs.ts picks and orders them), switching between them when there's more than one. Empty
// when the repo has no such markers. The dev-server preview lives in the rail's Preview area, not here.

const { dir, view } = defineProps<{ dir: string; view?: string | undefined }>();
const { tabsFor } = useDirectoryTabs();

// One activation per directory-surface view, not per extension: an extension can register several (e.g. Apps +
// Dependencies).
const activations = computed(() => tabsFor(dir));

// Falls back to the first activation, so a single-panel directory needs no selection, and a vanished choice lands on
// what remains.
const activeId = ref<string>();
// A caller that named a tab gets it, including when the panel was already open on another one; re-selecting by hand
// afterwards wins, since that writes the same ref.
watch(
    () => view,
    (named) => {
        if (named !== undefined) {
            activeId.value = named;
        }
    },
    { immediate: true },
);
const active = computed(() => activations.value.find(({ extension }) => extension.id === activeId.value) ?? activations.value[0]);
const options = computed(() => activations.value.map(({ extension }) => ({ label: extension.label, value: extension.id })));
const selected = computed<string>({
    get: () => active.value?.extension.id ?? ``,
    set: (id) => (activeId.value = id),
});
</script>

<template>
    <div v-if="active" class="flex h-full min-h-0 flex-col">
        <!-- Seven tabs outgrow a split pane's width, so the strip scrolls rather than clipping the last of them. -->
        <div v-if="activations.length > 1" class="scrollbar-none flex h-8 shrink-0 items-center overflow-x-auto border-b border-line px-1.5">
            <SegmentedControl v-model="selected" size="xs" :options="options" />
        </div>
        <div class="min-h-0 flex-1 overflow-auto">
            <ExtensionView :extension="active.extension" :activation="active.activation" />
        </div>
    </div>
</template>

<script setup lang="ts">
import { Segmented } from "@intentic/ui";
import { computed, ref } from "vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { usePanels } from "../../composables/extensions/usePanels";
import { detectActivations } from "../../core-views/registry";
import ExtensionView from "../../core-views/ExtensionView.vue";

/* The in-tree management surface for one repository directory: renders the directory-surface extension views the
 * repo activates (Apps, its own UI, the dev-server preview). With more than one, a segmented switch — the same
 * control the sidebar uses for Files/Changes/History — picks which. Empty (the repo lost its markers) renders
 * nothing; the tree only opens this for a manageable directory anyway. */

const { dir } = defineProps<{ dir: string }>();
const { panels } = usePanels();
const { capabilities } = useCapabilities();

// One activation per directory-surface VIEW for this repo — an extension may register several views (ext-apps
// contributes Apps + Dependencies), so the view id uniquely selects among them (activation.key is the repo
// name and collides across views).
const activations = computed(() =>
    detectActivations(panels.value, capabilities.value).filter(
        ({ extension, activation }) => extension.surface === `directory` && activation.repo === dir,
    ),
);

// The selected extension, falling back to the first — so a directory with one panel needs no interaction, and a
// selection that vanishes (its marker removed) lands on whatever remains.
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
            <Segmented v-model="selected" size="xs" :options="options" />
        </div>
        <div class="min-h-0 flex-1 overflow-auto scrollbar-thin">
            <ExtensionView :extension="active.extension" :activation="active.activation" />
        </div>
    </div>
</template>

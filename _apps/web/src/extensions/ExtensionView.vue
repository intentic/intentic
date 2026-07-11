<script lang="ts">
import { type Component, defineAsyncComponent } from "vue";
import { extensions } from "./index";

/* Renders one extension activation's view with its `repo` (+ props) bound — the single source consumed by both
 * hosts: the routed ExtensionHost (rail tiles) and the in-tree DirectoryOperator (per-repo directory panels). */

// One async component per extension, built once at module load, so a view never remounts when a host recomputes.
const views = new Map<string, Component>(extensions.map((extension) => [extension.id, defineAsyncComponent(extension.view)]));
</script>

<script setup lang="ts">
import { computed } from "vue";
import type { Activation, Extension } from "./extension";

const { extension, activation } = defineProps<{ extension: Extension; activation: Activation }>();
const view = computed(() => views.get(extension.id));
</script>

<template>
    <component
        :is="view"
        :key="`${extension.id}-${activation.key}`"
        v-bind="{ ...(activation.repo !== undefined ? { repo: activation.repo } : {}), ...activation.props }"
    />
</template>

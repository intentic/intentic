<script lang="ts">
import type { ViewRegistration } from "@intentic/extension-api";
import { type Component, defineAsyncComponent } from "vue";

/* Renders one extension activation's view with its `repo` (+ props) bound: the single source consumed by both
 * hosts: the routed ExtensionHost (rail tiles) and the in-tree DirectoryOperator (per-repo directory panels). */

// One async component per registration, created on first render and cached by registration identity: a view
// never remounts when a host recomputes, and runtime-registered extensions join the same cache (entries die
// with their registration when it's disposed).
const views = new WeakMap<ViewRegistration, Component>();
const viewOf = (registration: ViewRegistration): Component => {
    const cached = views.get(registration);
    if (cached !== undefined) {
        return cached;
    }
    const component = defineAsyncComponent(registration.view);
    views.set(registration, component);
    return component;
};
</script>

<script setup lang="ts">
import type { Activation } from "@intentic/extension-api";
import { computed } from "vue";
import ExtensionErrorBoundary from "./ExtensionErrorBoundary.vue";

const { extension, activation } = defineProps<{ extension: ViewRegistration; activation: Activation }>();
const view = computed(() => viewOf(extension));
</script>

<template>
    <ExtensionErrorBoundary :key="`${extension.id}-${activation.key}`" :extension-id="extension.id">
        <component :is="view" v-bind="{ ...(activation.repo !== undefined ? { repo: activation.repo } : {}), ...activation.props }" />
    </ExtensionErrorBoundary>
</template>

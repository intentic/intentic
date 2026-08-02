<script lang="ts">
import type { Component } from "vue";
import { defineAsyncComponent } from "vue";
import type { RegisteredDocumentProvider } from "./documentRegistry";

/* Renders one directory's extension-contributed document (documentRegistry) in a Workspace tab, with the
 * directory `path` bound — the document-tab counterpart of ExtensionView, and the same caching reason: one async
 * component per registration, so switching tabs never remounts the document and refetches it. */

const components = new WeakMap<RegisteredDocumentProvider, Component>();
const componentOf = (provider: RegisteredDocumentProvider): Component => {
    const cached = components.get(provider);
    if (cached !== undefined) {
        return cached;
    }
    const component = defineAsyncComponent(provider.component);
    components.set(provider, component);
    return component;
};
</script>

<script setup lang="ts">
import { cmp } from "@intentic/ui";
import { computed } from "vue";
import { documentProvider } from "./documentRegistry";
import ExtensionErrorBoundary from "./ExtensionErrorBoundary.vue";

const { extension, provider, path, title } = defineProps<{ extension: string; provider: string; path: string; title: string }>();

const registered = computed(() => documentProvider(extension, provider));
const view = computed(() => {
    const found = registered.value;
    return found === undefined ? undefined : componentOf(found);
});
</script>

<template>
    <ExtensionErrorBoundary v-if="view !== undefined && registered !== undefined" :key="`${extension}-${provider}-${path}`" :extension-id="extension">
        <component :is="view" :path="path" />
    </ExtensionErrorBoundary>
    <!-- The provider is gone — switched off from the Extensions tab, uninstalled, or simply not activated yet on
         a cold load. The tab stays put and says so, which is the honest state: closing it for the user would
         throw away a place they were reading, and an empty frame would read as a document that failed. -->
    <div v-else :class="cmp.emptyState(`m-6`)">
        <p class="text-sm">{{ title }} is not available.</p>
        <p class="mt-1 text-xs text-muted">
            The extension that explains <span class="font-mono">{{ path === `` ? `the workspace root` : path }}</span> is not running. Switch it back
            on in Sandbox → Extensions, and this tab will render again.
        </p>
    </div>
</template>

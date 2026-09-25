<script lang="ts">
import type { Component } from "vue";
import { defineAsyncComponent } from "vue";
import { loadChunk } from "@intentic/ui";
import type { RegisteredDocumentProvider } from "./documentRegistry";

/* Renders one directory's extension-contributed document (documentRegistry) in a Workspace tab, with the directory `path` bound. */

const components = new WeakMap<RegisteredDocumentProvider, Component>();
const componentOf = (provider: RegisteredDocumentProvider): Component => {
    const cached = components.get(provider);
    if (cached !== undefined) {
        return cached;
    }
    const component = defineAsyncComponent(() => loadChunk(provider.component));
    components.set(provider, component);
    return component;
};
</script>

<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { documentProvider } from "./documentRegistry";
import ExtensionErrorBoundary from "./ExtensionErrorBoundary.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

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
    <!-- The provider is gone: switched off from the Extensions tab, uninstalled, or simply not activated yet on a cold load. -->
    <div v-else :class="ui.emptyState(`m-6`)">
        <p class="text-sm">{{ t(`views.extensionDocument.notAvailable`, { title }) }}</p>
        <p class="mt-1 text-xs text-muted">
            {{ t(`views.extensionDocument.extensionExplains`) }}
            <span class="font-mono">{{ path === `` ? t(`views.words.workspaceRoot`) : path }}</span>
            {{ t(`views.extensionDocument.notRunningSwitchBack`) }}
        </p>
    </div>
</template>

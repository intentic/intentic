<script lang="ts">
import { type Component, defineAsyncComponent } from "vue";
import { loadChunk } from "@intentic/ui";

// One async component per registered loader, cached by identity like ExtensionView's: switching tabs, or the strip
// re-rendering, never reloads an extension's side view.
const bodies = new WeakMap<() => Promise<Component>, Component>();
const bodyOf = (load: () => Promise<Component>): Component => {
    const cached = bodies.get(load);
    if (cached !== undefined) {
        return cached;
    }
    const body = defineAsyncComponent(() => loadChunk(load));
    bodies.set(load, body);
    return body;
};
</script>

<script setup lang="ts">
import type { SideViewInput } from "@intentic/extension-api";
import { computed } from "vue";
import ExtensionErrorBoundary from "./ExtensionErrorBoundary.vue";

/* An extension's side view in its side panel tab: its component with the tab's input bound, inside the boundary that
   keeps a broken extension to its own tab. */

const { extensionId, view, input } = defineProps<{ extensionId: string; view: () => Promise<Component>; input: SideViewInput }>();
const body = computed(() => bodyOf(view));
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col overflow-auto">
        <ExtensionErrorBoundary :extension-id="extensionId">
            <component :is="body" :input="input" />
        </ExtensionErrorBoundary>
    </div>
</template>

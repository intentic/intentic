<script lang="ts">
import type { ViewRegistration } from "@intentic/extension-api";
import type { Component } from "vue";
import { type ViewChunk, viewChunk } from "../components/viewChunk";

/* Renders one extension activation's view with its `repo` (+ props) bound: the single source consumed by every host. */

// One chunk per registration, made on first render and kept by registration identity: a view never refetches when a
// host recomputes, and runtime-registered extensions join the same cache (entries die with their registration when it
// is disposed).
const chunks = new WeakMap<ViewRegistration, ViewChunk<Component>>();
const chunkOf = (registration: ViewRegistration): ViewChunk<Component> => {
    const known = chunks.get(registration);
    if (known !== undefined) {
        return known;
    }
    const chunk = viewChunk(registration.view);
    chunks.set(registration, chunk);
    return chunk;
};
</script>

<script setup lang="ts">
import type { Activation } from "@intentic/extension-api";
import { Await, EmptyState } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useChunkLoaded } from "../components/viewChunk";
import ExtensionErrorBoundary from "./ExtensionErrorBoundary.vue";
import ExtensionViewOutline from "./ExtensionViewOutline.vue";

const t = useT();

const {
    extension,
    activation,
    imprint: imprintName,
    waiting = false,
} = defineProps<{
    /** Unset while the host is still finding out which view this is (the extension has not registered yet). */
    extension?: ViewRegistration | undefined;
    activation?: Activation | undefined;
    /**
     * The name this view's imprint is drawn and taken under; one per activation by default. Pass one when the same
     * activation is drawn somewhere of another shape, or while `extension` is still unknown.
     */
    imprint?: string | undefined;
    /** The host has more to learn before it can say whether this view exists: keep drawing the wait. */
    waiting?: boolean;
}>();

const imprint = computed(() => imprintName ?? `ext:${extension?.id ?? ``}/${activation?.key ?? ``}`);

// From the host's first question to the view's first answers, one wait: the activation being found, its chunk, then
// whatever the view reads as it first draws (every read joins <Await>'s wait), all under the view's remembered look.
// A view the host has stopped looking for, with nothing to draw, asks for nothing (the host says why); never a wait.
const view = useChunkLoaded(
    () => (extension === undefined || activation === undefined ? undefined : chunkOf(extension)),
    () => waiting,
);
</script>

<template>
    <Await :of="view" :imprint="imprint" :label="t(`views.extensionView.loading`)">
        <template #default="{ data }">
            <ExtensionErrorBoundary v-if="extension !== undefined && activation !== undefined" :key="`${extension.id}-${activation.key}`" :extension-id="extension.id">
                <component :is="data" v-bind="{ ...(activation.repo !== undefined ? { repo: activation.repo } : {}), ...activation.props }" />
            </ExtensionErrorBoundary>
        </template>
        <template #fallback><ExtensionViewOutline :title="activation?.title" /></template>
        <template #failed="{ error }">
            <EmptyState
                tone="danger"
                :title="t(`views.extensionErrorBoundary.extensionCrashedRenderingView`, { extensionId: extension?.id ?? `` })"
                :line="error"
                class="h-full"
            />
        </template>
    </Await>
</template>

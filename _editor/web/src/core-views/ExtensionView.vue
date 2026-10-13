<script lang="ts">
import type { ViewRegistration } from "@intentic/extension-api";
import { type Component, defineAsyncComponent, shallowReactive } from "vue";
import { loadChunk } from "@intentic/ui";

/* Renders one extension activation's view with its `repo` (+ props) bound: the single source consumed by every host. */

// Where each registration's view chunk stands, so the wait below knows a view still arriving from one that failed
// (the boundary's card says that) or has landed. Absent until the view is first asked for, which also reads as waiting.
type ViewState = `loading` | `ready` | `failed`;
const states = shallowReactive(new WeakMap<ViewRegistration, ViewState>());

// One async component per registration, created on first render and cached by registration identity: a view
// never remounts when a host recomputes, and runtime-registered extensions join the same cache (entries die
// with their registration when it's disposed).
const views = new WeakMap<ViewRegistration, Component>();
const viewOf = (registration: ViewRegistration): Component => {
    const cached = views.get(registration);
    if (cached !== undefined) {
        return cached;
    }
    // A dead chunk's reload never settles here, so the wait stays up while the page goes.
    const component = defineAsyncComponent(async () => {
        states.set(registration, `loading`);
        let landed: Component | undefined;
        try {
            landed = await loadChunk(registration.view);
            return landed;
        } finally {
            states.set(registration, landed === undefined ? `failed` : `ready`);
        }
    });
    views.set(registration, component);
    return component;
};
</script>

<script setup lang="ts">
import type { Activation } from "@intentic/extension-api";
import { SkeletonSnapshot, useLoadingReveal, vSkeletonSource } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ExtensionErrorBoundary from "./ExtensionErrorBoundary.vue";
import ExtensionViewOutline from "./ExtensionViewOutline.vue";

const t = useT();

const {
    extension,
    activation,
    imprint: imprintName,
    waiting: hostWaiting = false,
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

const view = computed(() => (extension === undefined ? undefined : viewOf(extension)));
const imprint = computed(() => imprintName ?? `ext:${extension?.id ?? ``}/${activation?.key ?? ``}`);

// From the host's first question to the view's first frame, one wait: the activation being found, then its chunk.
// A chunk that failed is the boundary's to say, never a placeholder that waits on forever.
const waiting = computed(() => {
    if (extension === undefined) {
        return hostWaiting;
    }
    const state = states.get(extension);
    return state !== `ready` && state !== `failed`;
});
// The same reveal delay a route's chunk waits behind (asyncView), so a view that is a moment away never flashes grey.
const revealed = useLoadingReveal(waiting, imprint);
</script>

<template>
    <ExtensionErrorBoundary
        v-if="extension !== undefined && activation !== undefined"
        :key="`${extension.id}-${activation.key}`"
        :extension-id="extension.id"
    >
        <!-- `contents`, so the view lays out in its host as if nothing wrapped it, while this element is one thing to
             imprint whatever root the view has (a fragment included). It holds only a comment until the chunk lands. -->
        <div v-skeleton-source="imprint" class="contents">
            <component :is="view" v-bind="{ ...(activation.repo !== undefined ? { repo: activation.repo } : {}), ...activation.props }" />
        </div>
    </ExtensionErrorBoundary>
    <!-- After the boundary, not inside it, so this one wait stays mounted (and revealed) when the activation turns up
         partway through it. The view as it last looked; the outline only until it has been seen once. -->
    <SkeletonSnapshot v-if="waiting && revealed" :of="imprint" :label="t(`views.extensionView.loading`)">
        <ExtensionViewOutline :title="activation?.title" />
    </SkeletonSnapshot>
</template>

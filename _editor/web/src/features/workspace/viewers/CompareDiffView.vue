<script setup lang="ts">
import { Button } from "@intentic/ui";
import { errorMessage, useLatest } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { type Component, ref, shallowRef, watch } from "vue";
import { sandboxBlob } from "../../sandbox/client/sandboxClient";

// A document's diff drawn as one by the viewer that claims its format (viewerRegistry, `compare`): both versions'
// bytes fetched here, since daemon routes are Bearer-authenticated, and handed to the extension's component with the
// path. What the component cannot draw as one, this pane says, with the other two readings one press away.

// `before`/`after`: where the two sides' bytes live (daemon /diff/raw); `at`: another sandbox's daemon, absent for
// the active one; `compare`: the viewer's compare component, imported here so it and the bytes land together.
const { path, before, after, at, compare } = defineProps<{
    path: string;
    before: string;
    after: string;
    at?: string;
    compare: () => Promise<Component>;
}>();
// The reader wants the text reading, or both versions drawn whole; the host switches the reading.
const emit = defineEmits<{ text: []; sides: [] }>();

const t = useT();

const component = shallowRef<Component>();
const blobs = ref<{ before: Blob; after: Blob }>();
const loading = ref(false);
const error = ref<string>();

const latest = useLatest();
const load = (): void => {
    const isLatest = latest();
    loading.value = true;
    error.value = undefined;
    blobs.value = undefined;
    component.value = undefined;
    Promise.all([compare(), sandboxBlob(before, undefined, at), sandboxBlob(after, undefined, at)]).then(
        ([loaded, beforeBlob, afterBlob]) => {
            if (!isLatest()) {
                return;
            }
            component.value = loaded;
            blobs.value = { before: beforeBlob, after: afterBlob };
            loading.value = false;
        },
        (err: unknown) => {
            if (!isLatest()) {
                return;
            }
            loading.value = false;
            error.value = errorMessage(err, t(`workspace.compareDiffView.couldNotLoadVersions`));
        },
    );
};
watch(() => [before, after, at, compare] as const, load, { immediate: true });
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- A pair nothing could draw as one: said, with the readings that can still be had. -->
        <div v-if="error" class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-danger" />
            <p class="max-w-md text-sm text-danger">{{ error }}</p>
            <div class="flex items-center gap-2">
                <Button severity="secondary" @click="emit(`text`)">
                    <Icon name="robot" class="text-xs" />
                    {{ t(`workspace.compareDiffView.showTextInstead`) }}
                </Button>
                <Button severity="secondary" @click="emit(`sides`)">
                    <Icon name="split-columns" class="text-xs" />
                    {{ t(`workspace.derivedDiffView.showBothVersionsInstead`) }}
                </Button>
            </div>
        </div>
        <div v-else-if="loading || component === undefined || blobs === undefined" class="flex h-full items-center justify-center text-muted">
            <Icon name="spinner" class="text-xl" spin />
        </div>
        <component
            :is="component"
            v-else
            class="min-h-0 flex-1"
            :path="path"
            :before="blobs.before"
            :after="blobs.after"
            @failed="(message: string) => (error = message)"
        />
    </div>
</template>

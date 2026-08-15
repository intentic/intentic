<script setup lang="ts">
import { Code, ImageView, SegmentedControl } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";

/* SVG viewer: the picture by default, with a Source toggle for the markup. An SVG is the one format that is
 * genuinely both, which is why the host fetches it as TEXT (`fetch: "text"`) and this component makes the
 * image out of it — one read serves both halves of the toggle.
 *
 * The render goes through an <img> with a blob: object URL. Loading SVG as an IMAGE is what keeps any embedded
 * <script>/onload inert, and that is the whole security argument here: a workspace .svg is a file some agent
 * or download put there. NEVER inline the markup with v-html — that is an active context where scripts run,
 * i.e. stored XSS from a file in the tree. */

const { text } = defineProps<{ text: string }>();

const view = ref<`preview` | `source`>(`preview`);
const url = ref<string>();

const revoke = (): void => {
    if (url.value !== undefined) {
        URL.revokeObjectURL(url.value);
    }
};

watch(
    () => text,
    (next) => {
        revoke();
        url.value = URL.createObjectURL(new Blob([next], { type: `image/svg+xml` }));
    },
    { immediate: true },
);
onBeforeUnmount(revoke);

const options = computed(() => [
    { label: `Preview`, value: `preview` as const },
    { label: `Source`, value: `source` as const },
]);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center border-b border-line px-2 py-1.5">
            <SegmentedControl v-model="view" :options="options" />
        </div>
        <div class="min-h-0 flex-1">
            <ImageView v-if="view === 'preview' && url" :src="url" />
            <Code v-else-if="view === 'source'" :code="text" lang="xml" class="h-full overflow-auto" />
        </div>
    </div>
</template>

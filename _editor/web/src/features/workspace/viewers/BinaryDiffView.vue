<script setup lang="ts">
import { Button, formatBytes, ImageView, type ImageViewState, SegmentedControl, useDevice, ui } from "@intentic/ui";
import { extensionOf, formatOf } from "@intentic/ui/file-format";
import { errorMessage, useLatest } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { sandboxBlob } from "../../sandbox/client/sandboxClient";
import { useLayout } from "../../../shell/window/useLayout";
import { type RegisteredViewer, renderViewerForExtension, useViewerComponent } from "../../../core-views/viewerRegistry";
import ImageCompareView from "./ImageCompareView.vue";
import { type ImageSize, imageSize, type SidesComparison } from "./image/imageSides";
import { compareImageSides } from "./image/imageSidesClient";
import { useT } from "@intentic/ui/i18n";

// Before/after viewer for binary diffs: DiffView's framing, bytes instead of text. Bytes come from sandboxBlob as
// revocable blob: URLs, since daemon routes are Bearer-authenticated. A picture draws inline, both panes sharing one
// zoom/pan `view`, or laid over itself as a swipe or an onion skin (ImageCompareView); a format an extension's viewer
// claims is drawn by that viewer, once per side; anything else hands over the bytes.

// `at`: sandbox the bytes are on, absent for the active one; a wrong address could answer from a different file.
const t = useT();

const { path, before, after, at } = defineProps<{ path: string; before?: string; after?: string; at?: string }>();

const { mobile } = useDevice();
const { diffLayout } = useLayout();
// Two panes need the width for two; on a phone or Unified layout (DiffToolbar, same as DiffView) they stack
// instead of shrinking to thumbnails.
const split = computed(() => !mobile.value && diffLayout.value === `split` && before !== undefined && after !== undefined);
// A raster picture draws here whatever viewers are on; an SVG is markup, drawn by its viewer.
const renderable = computed(() => formatOf(path).category === `image` && formatOf(path).binary === true);
const filename = computed(() => path.slice(path.lastIndexOf(`/`) + 1));

// The extension viewer that can draw this format from bytes, for everything that isn't a picture. Reactive: switching
// the viewers extension off mid-review drops the panes to the download floor, the same as opening the file would.
const viewer = computed<RegisteredViewer | undefined>(() => (renderable.value ? undefined : renderViewerForExtension(extensionOf(path))));
// Imported once for both panes.
const viewerComponent = useViewerComponent(viewer);

interface Side {
    readonly url?: string;
    readonly size?: number;
    // Kept, not just measured: the comparison reuses this same Blob, not a second copy.
    readonly blob?: Blob;
    // The bytes decoded, only for a viewer whose manifest asks for `text`.
    readonly text?: string;
    readonly natural?: ImageSize;
    readonly error?: string;
    readonly loading: boolean;
}
const loaded = ref<Record<"before" | "after", Side>>({ before: { loading: false }, after: { loading: false } });
// What the two sides turn out to be, once both are in hand; see image/imageSides.ts.
const comparison = ref<SidesComparison>();
// Magnification and corner both panes show; zooming one zooms the other.
const view = ref<ImageViewState>({ fit: true });

// How two pictures are compared: beside each other, or laid over each other. Offered once both are drawn; a new
// file starts side by side, the reading that says what each picture is before any overlay says what moved.
type CompareMode = "sides" | "swipe" | "onion";
const compareMode = ref<CompareMode>(`sides`);
const COMPARE_OPTIONS = computed((): { label: string; value: CompareMode; title: string }[] => [
    { label: t(`workspace.binaryDiffView.twoUp`), value: `sides`, title: t(`workspace.binaryDiffView.bothPicturesBesideEachOther`) },
    { label: t(`workspace.binaryDiffView.swipe`), value: `swipe`, title: t(`workspace.binaryDiffView.afterWipedOverBefore`) },
    { label: t(`workspace.binaryDiffView.onionSkin`), value: `onion`, title: t(`workspace.binaryDiffView.afterFadedOverBefore`) },
]);
const overlayable = computed(() => renderable.value && loaded.value.before.url !== undefined && loaded.value.after.url !== undefined);
const overlay = computed(() => overlayable.value && compareMode.value !== `sides`);

// One fetch per present side, each revoking its own object URL on prop change or unmount.
const latestSides = useLatest();
watch(
    () => [before, after] as const,
    ([beforeUrl, afterUrl], _previous, onCleanup) => {
        const isLatest = latestSides();
        const created: string[] = [];
        onCleanup(() => {
            for (const url of created) {
                URL.revokeObjectURL(url);
            }
        });
        loaded.value = { before: { loading: beforeUrl !== undefined }, after: { loading: afterUrl !== undefined } };
        comparison.value = undefined;
        // A new file starts whole, at its own fit: the last file's magnification says nothing about this one.
        view.value = { fit: true };
        compareMode.value = `sides`;

        for (const [side, source] of [
            [`before`, beforeUrl],
            [`after`, afterUrl],
        ] as const) {
            if (source === undefined) {
                continue;
            }
            void sandboxBlob(source, undefined, at).then(
                (blob) => {
                    if (!isLatest()) {
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    created.push(url);
                    loaded.value = { ...loaded.value, [side]: { url, size: blob.size, blob, loading: false } };
                    // Natural size, fetched separately since decoding must not hold up drawing the picture.
                    void imageSize(blob).then((natural) => {
                        if (isLatest() && natural !== undefined) {
                            loaded.value = { ...loaded.value, [side]: { ...loaded.value[side], natural } };
                        }
                    });
                    // A text-fed viewer (an .svg) gets the markup, decoded once here rather than by each pane.
                    if (viewer.value?.fetch === `text`) {
                        void blob.text().then((text) => {
                            if (isLatest()) {
                                loaded.value = { ...loaded.value, [side]: { ...loaded.value[side], text } };
                            }
                        });
                    }
                },
                (error: unknown) => {
                    if (isLatest()) {
                        loaded.value = { ...loaded.value, [side]: { error: errorMessage(error, `Couldn't load this side.`), loading: false } };
                    }
                },
            );
        }
    },
    { immediate: true },
);

// Asked once both sides are in hand, of the bytes rather than of the reviewer's eyes.
const latestVerdict = useLatest();
watch(
    () => [loaded.value.before.blob, loaded.value.after.blob] as const,
    ([beforeBlob, afterBlob]) => {
        const isLatest = latestVerdict();
        comparison.value = undefined;
        if (beforeBlob === undefined || afterBlob === undefined) {
            return;
        }
        void compareImageSides({ before: beforeBlob, after: afterBlob }).then((verdict) => {
            if (isLatest()) {
                comparison.value = verdict;
            }
        });
    },
);

// The one content prop the viewer's manifest `fetch` kind asks for, and nothing spare: a leftover attr would fall
// through onto a viewer whose root is itself a component and win over its own binding. Undefined until the side has
// what that kind needs.
const viewerContent = (side: Side): { blob: Blob } | { text: string } | { src: string } | undefined => {
    switch (viewer.value?.fetch) {
        case `blob`:
            return side.blob === undefined ? undefined : { blob: side.blob };
        case `text`:
            return side.text === undefined ? undefined : { text: side.text };
        case `url`:
            return side.url === undefined ? undefined : { src: side.url };
        default:
            return undefined;
    }
};

// Saves one side's bytes via the object URL already rendering it: no second fetch, nothing extra to revoke.
const download = (side: Side, label: string): void => {
    if (side.url === undefined) {
        return;
    }
    const anchor = document.createElement(`a`);
    anchor.href = side.url;
    anchor.download = `${label}-${filename.value}`;
    anchor.click();
};

// How much the file grew/shrank. A delta, not a second size, since formatBytes' 2-sig-fig rounding can make two
// different sizes read identically.
const delta = computed(() => {
    const from = loaded.value.before.size;
    const to = loaded.value.after.size;
    if (from === undefined || to === undefined || from === to) {
        return undefined;
    }
    return `${to > from ? `+` : `−`}${formatBytes(Math.abs(to - from))}`;
});

// States whether the two sides are the same image; says nothing when shapes differ, since the captions above
// already show that.
const verdict = computed(() => {
    const answer = comparison.value;
    if (answer === undefined) {
        return undefined;
    }
    if (answer.kind === `bytes`) {
        return `Both sides are the same file: identical bytes.`;
    }
    if (answer.kind === `pixels`) {
        return `Both sides are the same picture: identical pixels, only the encoding differs.`;
    }
    // A share this small is a handful of pixels in a screenshot, and "0.0%" would read as "nothing".
    const share = answer.share < 0.001 ? `Under 0.1%` : `${(answer.share * 100).toFixed(answer.share >= 0.1 ? 0 : 1)}%`;
    return `Same dimensions: ${share} of the pixels changed.`;
});

// Panes actually drawn, before → after. A list, so the template states the pane once instead of a second markup
// branch that can drift.
const panes = computed(() =>
    (
        [
            { key: `before` as const, label: t(`workspace.binaryDiffView.before`), url: before },
            { key: `after` as const, label: t(`workspace.binaryDiffView.after`), url: after },
        ] as const
    ).flatMap((pane) => (pane.url === undefined ? [] : [{ key: pane.key, label: pane.label, side: loaded.value[pane.key] }])),
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- Verdict sits above both panes, as a statement about the pair, and the first thing read when the halves look alike. -->
        <div v-if="verdict || overlayable" class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-muted">
            <template v-if="verdict">
                <Icon name="info-circle" class="shrink-0 text-[0.7rem]" />
                <span class="min-w-0 truncate" v-tooltip.bottom.overflow="verdict">{{ verdict }}</span>
            </template>
            <span class="flex-1"></span>
            <SegmentedControl
                v-if="overlayable"
                :model-value="compareMode"
                :options="COMPARE_OPTIONS"
                size="xs"
                @update:model-value="(value: string) => (compareMode = value as CompareMode)"
            />
        </div>

        <!-- One pane for two pictures: the reading for a change too small to see across two panes. -->
        <div v-if="overlay && loaded.before.url && loaded.after.url" class="min-h-0 flex-1">
            <ImageCompareView :before="loaded.before.url" :after="loaded.after.url" :mode="compareMode === `swipe` ? `swipe` : `onion`" />
        </div>
        <div v-else class="flex min-h-0 flex-1 flex-col overflow-auto" :class="split ? 'md:flex-row' : ''">
            <div
                v-for="(pane, index) in panes"
                :key="pane.key"
                class="flex min-h-0 min-w-0 flex-1 flex-col"
                :class="split && index > 0 ? 'border-line md:border-l' : index > 0 ? 'border-t border-line' : ''"
            >
                <!-- Side label, picture dimensions, and file size; dimensions matter most, since that's what tells two same-sized screenshots apart. -->
                <div class="flex h-7 shrink-0 items-center gap-1.5 border-b border-line/60 px-2">
                    <span class="text-2xs font-medium uppercase tracking-wide" :class="pane.key === 'before' ? 'text-danger' : 'text-success'">
                        {{ pane.label }}
                    </span>
                    <span v-if="pane.side.natural" class="text-2xs tabular-nums text-subtle">
                        {{ pane.side.natural.w }} × {{ pane.side.natural.h }}
                    </span>
                    <span v-if="pane.side.size !== undefined" class="text-2xs text-subtle">{{ formatBytes(pane.side.size) }}</span>
                    <span
                        v-if="pane.key === 'after' && delta !== undefined"
                        class="text-2xs tabular-nums text-subtle"
                        v-tooltip.bottom="t(`workspace.binaryDiffView.againstBeforeSide`, { delta })"
                    >
                        {{ delta }}
                    </span>
                    <span class="flex-1"></span>
                    <button
                        v-if="pane.side.url"
                        type="button"
                        :class="ui.iconButton(`h-5 w-5 rounded`)"
                        @click="download(pane.side, pane.label.toLowerCase())"
                        v-tooltip.bottom="t(`workspace.binaryDiffView.downloadVersion`, { toLowerCase: pane.label.toLowerCase() })"
                        :aria-label="t(`workspace.binaryDiffView.downloadVersion2`, { toLowerCase: pane.label.toLowerCase(), filename })"
                    >
                        <Icon name="download" class="text-2xs" />
                    </button>
                </div>

                <div class="min-h-0 flex-1">
                    <div v-if="pane.side.loading" class="flex h-full items-center justify-center text-muted">
                        <Icon name="spinner" class="text-xl" spin />
                    </div>
                    <div v-else-if="pane.side.error" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                        <Icon name="exclamation-triangle" class="text-2xl text-danger" />
                        <p class="text-xs text-danger">{{ pane.side.error }}</p>
                    </div>
                    <!-- Shared view: zooming or panning either pane moves the other to match, the only way to compare two similar pictures by eye. -->
                    <ImageView
                        v-else-if="renderable && pane.side.url"
                        :src="pane.side.url"
                        :view="panes.length > 1 ? view : undefined"
                        @update:view="(next) => (view = next)"
                    />
                    <!-- The extension's own rendering of this format, one instance per side, fed exactly the content prop its manifest names. -->
                    <component
                        :is="viewerComponent"
                        v-else-if="viewerComponent && viewerContent(pane.side)"
                        :path="path"
                        v-bind="viewerContent(pane.side)"
                        @download="download(pane.side, pane.label.toLowerCase())"
                    />
                    <!-- A viewer that is still importing, or a text viewer still decoding: the side is here, its surface isn't yet. -->
                    <div v-else-if="viewer && pane.side.url" class="flex h-full items-center justify-center text-muted">
                        <Icon name="spinner" class="text-xl" spin />
                    </div>
                    <!-- Nothing draws this format: say what it is and hand over the bytes. -->
                    <div v-else class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                        <Icon name="box" class="text-3xl text-subtle" />
                        <p class="max-w-sm text-xs text-muted">{{ t(`workspace.binaryDiffView.binaryFileNoPreview`) }}</p>
                        <Button v-if="pane.side.url" severity="secondary" @click="download(pane.side, pane.label.toLowerCase())">
                            <Icon name="download" class="text-xs" />
                            {{ t(`ui.action.download`) }}
                        </Button>
                    </div>
                </div>
            </div>

            <!-- Neither side exists (mode-only change, or a path that vanished before this fetch); rare, but not an error. -->
            <p v-if="panes.length === 0" class="p-4 text-xs text-subtle">{{ t(`workspace.binaryDiffView.binaryFileNeitherSide`) }}</p>
        </div>
    </div>
</template>

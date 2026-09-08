<script setup lang="ts">
import { Button, formatBytes, ImageView, type ImageViewState, isRenderableImage, useDevice, ui } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { sandboxBlob } from "../../sandbox/client/sandboxClient";
import { useLayout } from "../../../shell/window/useLayout";
import { compareSides, type ImageSize, imageSize, type SidesComparison } from "./imageSides";

// Before/after viewer for binary diffs (mainly images): DiffView's framing, bytes instead of text. Bytes come from
// sandboxBlob as revocable blob: URLs, since daemon routes are Bearer-authenticated. Both panes share one zoom/pan
// `view`; only renderable images draw inline, others hand over the bytes.

// `at`: sandbox the bytes are on, absent for the active one; a wrong address could answer from a different file.
const { path, before, after, at } = defineProps<{ path: string; before?: string; after?: string; at?: string }>();

const { mobile } = useDevice();
const { diffLayout } = useLayout();
// Two panes need the width for two; on a phone or Unified layout (DiffToolbar, same as DiffView) they stack
// instead of shrinking to thumbnails.
const split = computed(() => !mobile.value && diffLayout.value === `split` && before !== undefined && after !== undefined);
// Path decides rendering via the kit's isRenderableImage, not the workspace's file-type resolver: showing a
// picture here can't be switched off by disabling a viewer extension.
const renderable = computed(() => isRenderableImage(path));
const filename = computed(() => path.slice(path.lastIndexOf(`/`) + 1));

interface Side {
    readonly url?: string;
    readonly size?: number;
    // Kept, not just measured: the comparison reuses this same Blob, not a second copy.
    readonly blob?: Blob;
    readonly natural?: ImageSize;
    readonly error?: string;
    readonly loading: boolean;
}
const loaded = ref<Record<"before" | "after", Side>>({ before: { loading: false }, after: { loading: false } });
// What the two sides turn out to be, once both are in hand; see imageSides.ts.
const comparison = ref<SidesComparison>();
// Magnification and corner both panes show; zooming one zooms the other.
const view = ref<ImageViewState>({ fit: true });

// One fetch per present side, each revoking its own object URL on prop change or unmount. A monotonic token
// drops a stale response for a file already left.
let seq = 0;
watch(
    () => [before, after] as const,
    ([beforeUrl, afterUrl], _previous, onCleanup) => {
        const token = ++seq;
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

        for (const [side, source] of [
            [`before`, beforeUrl],
            [`after`, afterUrl],
        ] as const) {
            if (source === undefined) {
                continue;
            }
            void sandboxBlob(source, undefined, at).then(
                (blob) => {
                    if (token !== seq) {
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    created.push(url);
                    loaded.value = { ...loaded.value, [side]: { url, size: blob.size, blob, loading: false } };
                    // Natural size, fetched separately since decoding must not hold up drawing the picture.
                    void imageSize(blob).then((natural) => {
                        if (token === seq && natural !== undefined) {
                            loaded.value = { ...loaded.value, [side]: { ...loaded.value[side], natural } };
                        }
                    });
                },
                (error: unknown) => {
                    if (token === seq) {
                        loaded.value = { ...loaded.value, [side]: { error: errorMessage(error, `Couldn't load this side.`), loading: false } };
                    }
                },
            );
        }
    },
    { immediate: true },
);

// Asked once both sides are in hand, of the bytes rather than of the reviewer's eyes.
watch(
    () => [loaded.value.before.blob, loaded.value.after.blob] as const,
    ([beforeBlob, afterBlob]) => {
        comparison.value = undefined;
        if (beforeBlob === undefined || afterBlob === undefined) {
            return;
        }
        const token = seq;
        void compareSides(beforeBlob, afterBlob).then((verdict) => {
            if (token === seq) {
                comparison.value = verdict;
            }
        });
    },
);

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
            { key: `before` as const, label: `Before`, url: before },
            { key: `after` as const, label: `After`, url: after },
        ] as const
    ).flatMap((pane) => (pane.url === undefined ? [] : [{ key: pane.key, label: pane.label, side: loaded.value[pane.key] }])),
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- Verdict sits above both panes, as a statement about the pair, and the first thing read when the halves look alike. -->
        <div v-if="verdict" class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-muted">
            <Icon name="info-circle" class="shrink-0 text-[0.7rem]" />
            <span class="min-w-0 truncate" v-tooltip.bottom.overflow="verdict">{{ verdict }}</span>
        </div>

        <div class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-auto" :class="split ? 'md:flex-row' : ''">
            <div
                v-for="(pane, index) in panes"
                :key="pane.key"
                class="flex min-h-0 min-w-0 flex-1 flex-col"
                :class="split && index > 0 ? 'border-line md:border-l' : index > 0 ? 'border-t border-line' : ''"
            >
                <!--
                    Side label, picture dimensions, and file size; dimensions matter most, since that's what tells two same-sized
                    screenshots apart. After side also states the delta.
                -->
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
                        v-tooltip.bottom="`${delta} against the before side`"
                    >
                        {{ delta }}
                    </span>
                    <span class="flex-1"></span>
                    <button
                        v-if="pane.side.url"
                        type="button"
                        :class="ui.iconButton(`h-5 w-5 rounded`)"
                        @click="download(pane.side, pane.label.toLowerCase())"
                        v-tooltip.bottom="`Download the ${pane.label.toLowerCase()} version`"
                        :aria-label="`Download the ${pane.label.toLowerCase()} version of ${filename}`"
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
                    <!--
                        Shared view: zooming or panning either pane moves the other to match, the only way to compare two similar
                        pictures by eye.
                    -->
                    <ImageView
                        v-else-if="renderable && pane.side.url"
                        :src="pane.side.url"
                        :view="panes.length > 1 ? view : undefined"
                        @update:view="(next) => (view = next)"
                    />
                    <!-- Not an image: nothing to compare visually, so say what it is and hand over the bytes. -->
                    <div v-else class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                        <Icon name="box" class="text-3xl text-subtle" />
                        <p class="max-w-sm text-xs text-muted">Binary file: no preview for this type.</p>
                        <Button v-if="pane.side.url" severity="secondary" @click="download(pane.side, pane.label.toLowerCase())">
                            <Icon name="download" class="text-xs" />
                            Download
                        </Button>
                    </div>
                </div>
            </div>

            <!-- Neither side exists (mode-only change, or a path that vanished before this fetch); rare, but not an error. -->
            <p v-if="panes.length === 0" class="p-4 text-xs text-subtle">Binary file: neither side has content to show.</p>
        </div>
    </div>
</template>

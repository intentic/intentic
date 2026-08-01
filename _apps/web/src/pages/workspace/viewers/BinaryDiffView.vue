<script setup lang="ts">
import { formatBytes, ImageView, isRenderableImage, useDevice } from "@intentic-app/ui";
import { computed, ref, watch } from "vue";
import { sandboxBlob } from "../../../composables/sandbox/sandboxClient";
import { errorMessage } from "../../../composables/useAsyncAction";
import { useLayout } from "../../../composables/useLayout";

/* WHAT CHANGED, WHEN THE CHANGE ISN'T TEXT. Monaco's diff editor is the right tool for a file made of lines and
 * the wrong one for a screenshot, so every review surface used to stop at "Binary file — no text diff to show."
 * — over a PNG the workspace's own file view renders without trouble two clicks away. This is the viewer that
 * takes that slot: the same before/after framing DiffView gives text, with the bytes rendered instead of read.
 *
 * SEEING BOTH IS THE WHOLE POINT, so a modified image gets two panes and one caption per side — an icon
 * changing shade, a screenshot regaining a cropped edge, a logo swapped for another logo are all invisible in
 * "binary, 41 KB → 43 KB". An added or deleted file has only the one side it ever had, and gets the pane to
 * itself rather than half a screen of blank next to it: the caller passes only the URLs its row's status says
 * exist, so absence here is information, not a failed fetch.
 *
 * The bytes come from the daemon's /diff/raw (one side per request, resolved server-side from the same diff the
 * JSON came from), fetched through the sandbox client rather than put straight in an <img src> — every daemon
 * route is Bearer-authenticated, which a browser-issued image request cannot be. Hence the blob: URL, and hence
 * the revoke on the watcher's cleanup: same lifecycle FileViewer runs for the file tree's images, leak-safe
 * across a fast walk through a list of them.
 *
 * Only images render inline. A font, an archive, a .wasm has no visual form to compare — for those the pane
 * states what it is and offers the bytes, which is the honest end of the road rather than a placeholder. */

const { path, before, after } = defineProps<{ path: string; before?: string; after?: string }>();

const { mobile } = useDevice();
const { diffLayout } = useLayout();
// Two panes need the width for two: on a phone (or under the reader's Unified setting — the same one DiffView
// obeys, set from DiffToolbar) they stack instead, so each side still gets the full column rather than two
// unreadable thumbnails.
const split = computed(() => !mobile.value && diffLayout.value === `split` && before !== undefined && after !== undefined);
/* The path decides how the bytes are shown — not their content. Asked of the KIT (isRenderableImage), beside
 * the component that would draw them, rather than of the workspace's file-type resolver: showing a picture in
 * a diff is a review capability and must not be able to disappear because a viewers extension was switched
 * off. A .png in a diff and a .png in the tree still agree, because the extension's manifest claims the same
 * set the kit knows how to paint. */
const renderable = computed(() => isRenderableImage(path));
const filename = computed(() => path.slice(path.lastIndexOf(`/`) + 1));

interface Side {
    readonly url?: string;
    readonly size?: number;
    readonly error?: string;
    readonly loading: boolean;
}
const loaded = ref<Record<"before" | "after", Side>>({ before: { loading: false }, after: { loading: false } });

// One fetch per present side, each owning the object URL it creates and revoking it when the props change or
// the component goes away. A monotonic token drops a slow response for a file the reviewer has already left.
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

        for (const [side, source] of [
            [`before`, beforeUrl],
            [`after`, afterUrl],
        ] as const) {
            if (source === undefined) {
                continue;
            }
            void sandboxBlob(source).then(
                (blob) => {
                    if (token !== seq) {
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    created.push(url);
                    loaded.value = { ...loaded.value, [side]: { url, size: blob.size, loading: false } };
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

// Save one side's bytes. The blob is already in memory, so this is a link click over the object URL that is
// already rendering it — no second fetch, and nothing extra to revoke.
const download = (side: Side, label: string): void => {
    if (side.url === undefined) {
        return;
    }
    const anchor = document.createElement(`a`);
    anchor.href = side.url;
    anchor.download = `${label}-${filename.value}`;
    anchor.click();
};

// The panes actually drawn, in before → after order. Built as a list so the template states the pane once and
// the one-sided case is a list of one rather than a second branch of markup that can drift from the first.
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
    <div class="flex h-full min-h-0 flex-col overflow-auto" :class="split ? 'md:flex-row' : ''">
        <div
            v-for="(pane, index) in panes"
            :key="pane.key"
            class="flex min-h-0 min-w-0 flex-1 flex-col"
            :class="split && index > 0 ? 'border-line md:border-l' : index > 0 ? 'border-t border-line' : ''"
        >
            <!-- Which side this is, and how big it is — the one number a binary diff can always report, and the
                 only thing that distinguishes two images that look alike. -->
            <div class="flex h-7 shrink-0 items-center gap-1.5 border-b border-line/60 px-2">
                <span class="text-2xs font-medium uppercase tracking-wide" :class="pane.key === 'before' ? 'text-danger' : 'text-success'">
                    {{ pane.label }}
                </span>
                <span v-if="pane.side.size !== undefined" class="text-2xs text-subtle">{{ formatBytes(pane.side.size) }}</span>
                <span class="flex-1"></span>
                <button
                    v-if="pane.side.url"
                    type="button"
                    class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-content"
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
                <ImageView v-else-if="renderable && pane.side.url" :src="pane.side.url" />
                <!-- Not an image: nothing to compare visually, so say what it is and hand over the bytes. -->
                <div v-else class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                    <Icon name="box" class="text-3xl text-subtle" />
                    <p class="max-w-sm text-xs text-muted">Binary file — no preview for this type.</p>
                    <button
                        v-if="pane.side.url"
                        type="button"
                        class="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-content transition-colors hover:border-line-strong hover:bg-overlay"
                        @click="download(pane.side, pane.label.toLowerCase())"
                    >
                        <Icon name="download" class="text-xs" />
                        Download
                    </button>
                </div>
            </div>
        </div>

        <!-- Neither side exists: the daemon reported a binary change whose bytes are on neither end of it. Rare
             (a mode-only change, a path that vanished between the diff and this fetch) but not an error. -->
        <p v-if="panes.length === 0" class="p-4 text-xs text-subtle">Binary file — neither side has content to show.</p>
    </div>
</template>

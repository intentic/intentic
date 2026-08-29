<script setup lang="ts">
import { formatBytes, ImageView, type ImageViewState, isRenderableImage, useDevice } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { sandboxBlob } from "../../../composables/sandbox/sandboxClient";
import { useLayout } from "../../../composables/useLayout";
import { compareSides, type ImageSize, imageSize, type SidesComparison } from "./imageSides";

/* WHAT CHANGED, WHEN THE CHANGE ISN'T TEXT. Monaco's diff editor is the right tool for a file made of lines and
 * the wrong one for a screenshot, so every review surface used to stop at "Binary file: no text diff to show."
 *: over a PNG the workspace's own file view renders without trouble two clicks away. This is the viewer that
 * takes that slot: the same before/after framing DiffView gives text, with the bytes rendered instead of read.
 *
 * SEEING BOTH IS THE WHOLE POINT, so a modified image gets two panes and one caption per side: an icon
 * changing shade, a screenshot regaining a cropped edge, a logo swapped for another logo are all invisible in
 * "binary, 41 KB → 43 KB". An added or deleted file has only the one side it ever had, and gets the pane to
 * itself rather than half a screen of blank next to it: the caller passes only the URLs its row's status says
 * exist, so absence here is information, not a failed fetch.
 *
 * …AND SEEING BOTH IS NOT THE SAME AS SEEING THE DIFFERENCE, which is the second half of the job and used to be
 * left entirely to the reviewer's eyes. Two re-captures of the same screen fill both panes with what reads as
 * one picture: fitted to the pane they are ~27% of themselves, where a changed figure is a smudge, and the one
 * fact the caption offered, the size, rounded 2 723 548 B and 2 697 608 B to "2.6 MB" apiece. A viewer that
 * cannot tell a reviewer whether anything changed gets reported as a viewer that shows the same picture twice,
 * which is exactly what happened. So each side now states its DIMENSIONS beside its size, the after side states
 * how much the file grew or shrank, and a line above the panes answers the question outright when the pictures
 * are the same shape (imageSides.ts): identical bytes, identical pixels under a different encoding, or the
 * share of pixels that moved, which is the number a re-capture is really being judged on. Both sides zoom and
 * pan TOGETHER (ImageView's `view`), because comparing two screenshots means looking at the same corner of each
 * at the same magnification, which two independently fitted panes can never quite be.
 *
 * The bytes come from the daemon's /diff/raw (one side per request, resolved server-side from the same diff the
 * JSON came from), fetched through the sandbox client rather than put straight in an <img src>: every daemon
 * route is Bearer-authenticated, which a browser-issued image request cannot be. Hence the blob: URL, and hence
 * the revoke on the watcher's cleanup: same lifecycle FileViewer runs for the file tree's images, leak-safe
 * across a fast walk through a list of them.
 *
 * Only images render inline. A font, an archive, a .wasm has no visual form to compare: for those the pane
 * states what it is and offers the bytes, which is the honest end of the road rather than a placeholder. */

const { path, before, after } = defineProps<{ path: string; before?: string; after?: string }>();

const { mobile } = useDevice();
const { diffLayout } = useLayout();
// Two panes need the width for two: on a phone (or under the reader's Unified setting, the same one DiffView
// obeys, set from DiffToolbar) they stack instead, so each side still gets the full column rather than two
// unreadable thumbnails.
const split = computed(() => !mobile.value && diffLayout.value === `split` && before !== undefined && after !== undefined);
/* The path decides how the bytes are shown, not their content. Asked of the KIT (isRenderableImage), beside
 * the component that would draw them, rather than of the workspace's file-type resolver: showing a picture in
 * a diff is a review capability and must not be able to disappear because a viewers extension was switched
 * off. A .png in a diff and a .png in the tree still agree, because the extension's manifest claims the same
 * set the kit knows how to paint. */
const renderable = computed(() => isRenderableImage(path));
const filename = computed(() => path.slice(path.lastIndexOf(`/`) + 1));

interface Side {
    readonly url?: string;
    readonly size?: number;
    // Kept, not just measured: the comparison below needs the bytes, and they are the same bytes the pane is
    // already rendering, so holding the Blob costs a reference rather than a second copy.
    readonly blob?: Blob;
    readonly natural?: ImageSize;
    readonly error?: string;
    readonly loading: boolean;
}
const loaded = ref<Record<"before" | "after", Side>>({ before: { loading: false }, after: { loading: false } });
// What the two sides turn out to be, once both are in hand; see imageSides.ts.
const comparison = ref<SidesComparison>();
// The magnification and corner BOTH panes are showing, so a zoom into one is a zoom into the other.
const view = ref<ImageViewState>({ fit: true });

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
            void sandboxBlob(source).then(
                (blob) => {
                    if (token !== seq) {
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    created.push(url);
                    loaded.value = { ...loaded.value, [side]: { url, size: blob.size, blob, loading: false } };
                    // The caption's other half, and the one that tells two screenshots apart at a glance. Late
                    // and separate because it costs a decode, which must not hold up drawing the picture.
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

// Save one side's bytes. The blob is already in memory, so this is a link click over the object URL that is
// already rendering it: no second fetch, and nothing extra to revoke.
const download = (side: Side, label: string): void => {
    if (side.url === undefined) {
        return;
    }
    const anchor = document.createElement(`a`);
    anchor.href = side.url;
    anchor.download = `${label}-${filename.value}`;
    anchor.click();
};

/* How much the file grew or shrank, for the after side's caption. The reason it is a DELTA and not a second
 * size: formatBytes carries two significant figures, so the 25 KB a re-capture actually lost reads as "2.6 MB"
 * on one side and "2.6 MB" on the other, and a reviewer comparing those two labels learns nothing. */
const delta = computed(() => {
    const from = loaded.value.before.size;
    const to = loaded.value.after.size;
    if (from === undefined || to === undefined || from === to) {
        return undefined;
    }
    return `${to > from ? `+` : `−`}${formatBytes(Math.abs(to - from))}`;
});

/* The one sentence a reviewer of a screenshot wants and could not previously get from this pane. Nothing is
 * said when the two sides are different shapes: the captions above the pictures already say that, and a line
 * repeating what is on screen teaches a reader to stop reading the line. */
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
    <div class="flex h-full min-h-0 flex-col">
        <!-- The verdict, when there is one to give. Above the panes rather than inside one, because it is a
             statement about the pair, and it is the first thing to read when both halves look alike. -->
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
                <!-- Which side this is, how big the PICTURE is and how big the FILE is. The dimensions carry
                     most of the weight: they are what separates two screenshots that read as one image, and
                     they cost nothing to state. The after side adds what the file gained or lost, because two
                     sizes rounded to the same label are not a comparison. -->
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
                    <!-- One view for both sides: zooming or panning either pane moves the other to the same
                         place, which is the only way two pictures this alike can be compared by eye. -->
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

            <!-- Neither side exists: the daemon reported a binary change whose bytes are on neither end of it.
                 Rare (a mode-only change, a path that vanished between the diff and this fetch) but not an
                 error. -->
            <p v-if="panes.length === 0" class="p-4 text-xs text-subtle">Binary file: neither side has content to show.</p>
        </div>
    </div>
</template>

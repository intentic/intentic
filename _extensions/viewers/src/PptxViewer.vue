<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Deck, ImageBox, Paragraph, TextBox } from "./pptx/deck-model";
import { t } from "./i18n.js";

/* PPTX preview: the deck unpacked in the tab and drawn as slides. All the reading is in src/pptx — this file only
   turns boxes into elements, so anything that looks wrong on a slide was decided by the parse, not here. */

const { blob } = defineProps<{ blob: Blob }>();

const deck = ref<Deck>();
const loading = ref(true);
const error = ref<string>();
const notesShown = ref(true);
// One slide is drawn at its true pixel size and scaled as a whole, so every position inside it stays exact.
const scale = ref(1);
const surface = ref<HTMLElement>();
// Drops a stale parse when the open file changes mid-read (a new blob prop supersedes the in-flight one).
let seq = 0;
// Object URLs live as long as the deck that owns them; a switched file revokes every one of them.
const pictures = new Map<ImageBox, string>();

const revokePictures = (): void => {
    for (const url of pictures.values()) {
        URL.revokeObjectURL(url);
    }
    pictures.clear();
};

const pictureOf = (box: ImageBox): string => {
    const known = pictures.get(box);
    if (known !== undefined) {
        return known;
    }
    // Copied out of the zip's buffer: fflate hands back views over one backing store it also decompresses into.
    const url = URL.createObjectURL(new Blob([new Uint8Array(box.bytes)], { type: box.mime }));
    pictures.set(box, url);
    return url;
};

// Fit to width, and no further: a 1280px slide in a 400px pane is unreadable either way, but one blown up to 3000px
// on a wide screen just looks broken.
const MAX_SCALE = 1.5;
const GUTTER = 32;

const fit = (): void => {
    const available = surface.value?.clientWidth ?? 0;
    const width = deck.value?.width ?? 0;
    // A pane that has not been laid out yet reports no width at all (a hidden tab, the frame before mount). Keeping
    // the scale we had beats shrinking the whole deck to a floor it would then have to be resized out of.
    if (available <= GUTTER || width === 0) {
        return;
    }
    scale.value = Math.min(MAX_SCALE, (available - GUTTER) / width);
};

const render = async (source: Blob): Promise<void> => {
    const id = ++seq;
    loading.value = true;
    error.value = undefined;
    try {
        // Lazy: fflate and the whole OOXML reader stay out of the bundle until someone opens a deck.
        const { readDeck } = await import("./pptx/deck");
        const bytes = new Uint8Array(await source.arrayBuffer());
        if (id !== seq) {
            return;
        }
        revokePictures();
        deck.value = readDeck(bytes);
        fit();
    } catch (caught) {
        if (id !== seq) {
            return;
        }
        error.value = caught instanceof Error ? caught.message : `Could not read this presentation.`;
    } finally {
        if (id === seq) {
            loading.value = false;
        }
    }
};

const observer = new ResizeObserver(() => fit());

onMounted(() => {
    void render(blob);
    if (surface.value !== undefined) {
        observer.observe(surface.value);
    }
});
watch(
    () => blob,
    (next) => void render(next),
);
onBeforeUnmount(() => {
    seq += 1;
    observer.disconnect();
    revokePictures();
});

const px = (value: number): string => `${value}px`;

const slideStyle = computed(() => ({ width: px(deck.value?.width ?? 0), height: px(deck.value?.height ?? 0) }));
// The scaled box the unscaled slide is drawn into, so the page's own layout knows how tall each slide really is.
const frameStyle = computed(() => ({ width: px((deck.value?.width ?? 0) * scale.value), height: px((deck.value?.height ?? 0) * scale.value) }));

const boxStyle = (box: { x: number; y: number; width: number; height: number; rotation: number }): Record<string, string> => ({
    left: px(box.x),
    top: px(box.y),
    width: px(box.width),
    height: px(box.height),
    ...(box.rotation === 0 ? {} : { transform: `rotate(${box.rotation}deg)` }),
});

const ANCHORS: Record<TextBox["anchor"], string> = { start: `flex-start`, center: `center`, end: `flex-end` };

const textStyle = (box: TextBox): Record<string, string> => ({
    ...boxStyle(box),
    justifyContent: ANCHORS[box.anchor],
    ...(box.fill === undefined ? {} : { background: box.fill }),
    ...(box.outline === undefined ? {} : { border: `${px(box.outline.width)} solid ${box.outline.color}` }),
    ...(box.shape === `ellipse` ? { borderRadius: `50%` } : box.shape === `round` ? { borderRadius: `0.5rem` } : {}),
});

const paragraphStyle = (paragraph: Paragraph): Record<string, string> => ({
    textAlign: paragraph.align,
    paddingLeft: px(paragraph.indent),
    lineHeight: String(paragraph.lineHeight),
    ...(paragraph.spaceBefore === 0 ? {} : { marginTop: px(paragraph.spaceBefore) }),
});

const runStyle = (run: {
    size: number;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    color: string;
    font: string | undefined;
}): Record<string, string> => ({
    fontSize: px(run.size),
    color: run.color,
    ...(run.bold ? { fontWeight: `700` } : {}),
    ...(run.italic ? { fontStyle: `italic` } : {}),
    ...(run.underline ? { textDecoration: `underline` } : {}),
    ...(run.font === undefined ? {} : { fontFamily: `${run.font}, sans-serif` }),
});

// The bullet takes the size of the text it introduces, which is what keeps a 40pt heading's dash from being a speck.
const bulletStyle = (paragraph: Paragraph): Record<string, string> => ({
    fontSize: px(paragraph.runs[0]?.size ?? 18),
    color: paragraph.runs[0]?.color ?? `inherit`,
});

const hasNotes = computed(() => deck.value?.slides.some((slide) => slide.notes.length > 0) === true);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div
            v-if="deck !== undefined && !loading"
            class="flex shrink-0 items-center gap-3 border-b border-line-subtle px-3 py-1.5 text-2xs text-muted"
        >
            <span>{{ deck.slides.length }} {{ deck.slides.length === 1 ? `slide` : `slides` }}</span>
            <button
                v-if="hasNotes"
                type="button"
                class="ui-chip gap-1 rounded-md px-1.5 py-0.5"
                :aria-pressed="notesShown"
                @click="notesShown = !notesShown"
            >
                <Icon :name="notesShown ? `eye` : `eye-slash`" class="text-2xs" />
                {{ t(`pptxViewer.speakerNotes`) }}
            </button>
        </div>
        <div ref="surface" class="ui-softscroll relative min-h-0 flex-1 overflow-auto bg-muted/20 px-4 py-4">
            <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-canvas text-muted">
                <Icon name="spinner" class="text-xl" spin />
            </div>
            <div v-else-if="error" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas px-6 text-center">
                <Icon name="exclamation-triangle" class="text-3xl text-danger" />
                <p class="text-sm text-danger">{{ error }}</p>
            </div>
            <p v-else-if="deck === undefined || deck.slides.length === 0" class="py-10 text-center text-sm text-muted">
                {{ t(`pptxViewer.presentationNoSlides`) }}
            </p>
            <div v-else class="mx-auto flex flex-col items-center gap-6">
                <figure v-for="slide of deck.slides" :key="slide.number" class="flex flex-col items-center gap-1">
                    <div class="pptx-frame overflow-hidden rounded-sm shadow-md ring-1 ring-line" :style="frameStyle">
                        <!-- Drawn at the deck's own pixel size and scaled as one piece: every box inside keeps its exact place. -->
                        <div
                            class="pptx-slide relative origin-top-left overflow-hidden"
                            :style="{ ...slideStyle, transform: `scale(${scale})`, background: slide.background ?? `#ffffff` }"
                        >
                            <template v-for="(box, index) of slide.boxes" :key="index">
                                <div v-if="box.kind === `text`" class="pptx-box absolute flex flex-col" :style="textStyle(box)">
                                    <p
                                        v-for="(paragraph, line) of box.paragraphs"
                                        :key="line"
                                        class="pptx-para flex"
                                        :style="paragraphStyle(paragraph)"
                                    >
                                        <span v-if="paragraph.bullet !== undefined" class="pptx-bullet" :style="bulletStyle(paragraph)">{{
                                            paragraph.bullet
                                        }}</span>
                                        <span class="min-w-0 flex-1">
                                            <span v-for="(run, spot) of paragraph.runs" :key="spot" :style="runStyle(run)">{{ run.text }}</span>
                                        </span>
                                    </p>
                                </div>
                                <img
                                    v-else-if="box.kind === `image`"
                                    class="pptx-box absolute"
                                    :style="boxStyle(box)"
                                    :src="pictureOf(box)"
                                    :alt="box.description ?? t(`pptxViewer.pictureOnSlide`, { number: slide.number })"
                                />
                                <table v-else-if="box.kind === `table`" class="pptx-table absolute" :style="boxStyle(box)">
                                    <colgroup>
                                        <col v-for="(width, column) of box.columns" :key="column" :style="{ width: px(width) }" />
                                    </colgroup>
                                    <tbody>
                                        <tr v-for="(row, line) of box.rows" :key="line" :style="{ height: px(row.height) }">
                                            <td
                                                v-for="(cell, spot) of row.cells"
                                                :key="spot"
                                                :colspan="cell.colSpan"
                                                :rowspan="cell.rowSpan"
                                                :style="cell.fill === undefined ? {} : { background: cell.fill }"
                                            >
                                                <p v-for="(paragraph, index2) of cell.paragraphs" :key="index2" :style="paragraphStyle(paragraph)">
                                                    <span v-for="(run, spot2) of paragraph.runs" :key="spot2" :style="runStyle(run)">{{
                                                        run.text
                                                    }}</span>
                                                </p>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <!-- Named rather than dropped: a chart this viewer cannot draw is still something on the slide. -->
                                <div
                                    v-else
                                    class="pptx-box absolute flex flex-col items-center justify-center gap-1 rounded border border-dashed border-line text-muted"
                                    :style="boxStyle(box)"
                                >
                                    <Icon name="box" class="text-xl" />
                                    <span class="text-xs">{{ box.label }}</span>
                                </div>
                            </template>
                        </div>
                    </div>
                    <figcaption class="flex flex-col items-center gap-1 text-2xs text-subtle" :style="{ width: frameStyle.width }">
                        <span>{{ t(`pptxViewer.slide`, { number: slide.number }) }}</span>
                        <div
                            v-if="notesShown && slide.notes.length > 0"
                            class="w-full rounded border border-line bg-canvas px-3 py-2 text-left text-xs text-muted"
                        >
                            <p v-for="(note, index) of slide.notes" :key="index" class="whitespace-pre-wrap">{{ note }}</p>
                        </div>
                    </figcaption>
                </figure>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Slide coordinates are absolute and overlapping by design; nothing here may collapse, wrap or reflow a box. */
.pptx-box {
    box-sizing: border-box;
    overflow: hidden;
}
.pptx-slide p {
    margin: 0;
    white-space: pre-wrap;
    /* A long word in a narrow box overflows the slide in PowerPoint too, but a scrollbar here would be this app's. */
    overflow-wrap: break-word;
}
.pptx-bullet {
    flex: none;
    padding-right: 0.4em;
}
.pptx-table {
    border-collapse: collapse;
    table-layout: fixed;
}
.pptx-table td {
    border: 1px solid var(--color-line);
    padding: 0.25rem 0.4rem;
    vertical-align: middle;
}
</style>

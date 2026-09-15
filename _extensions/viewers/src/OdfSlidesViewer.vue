<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { openOdf, type OdfPackage } from "./odf/pkg";
import { renderBlocks } from "./odf/render";
import { readPresentation, type Slide } from "./odf/slides";

/* OpenDocument presentation and drawing (.odp, .odg) preview: every slide at its own size, scaled to fit. */

const { blob } = defineProps<{ blob: Blob }>();

const container = ref<HTMLElement>();
const loading = ref(true);
const error = ref<string>();
const count = ref(0);
let seq = 0;
let open: OdfPackage | undefined;
// One observer for the whole strip: every slide is the same width, so the scale is a single number.
let observer: ResizeObserver | undefined;

// CSS renders a centimetre as 96/2.54 px, which is what a slide's absolute positions mean once they are on screen.
const PX_PER_CM = 96 / 2.54;

const release = (): void => {
    open?.dispose();
    open = undefined;
    observer?.disconnect();
    observer = undefined;
};

const slideNode = (slide: Slide, index: number, width: number, height: number, doc: Document): HTMLElement => {
    const wrapper = doc.createElement(`section`);
    wrapper.className = `odf-slide-wrap`;
    const stage = doc.createElement(`div`);
    stage.className = `odf-slide`;
    stage.style.width = `${width * PX_PER_CM}px`;
    stage.style.height = `${height * PX_PER_CM}px`;
    if (slide.background !== undefined) {
        stage.style.background = slide.background;
    }
    for (const shape of slide.shapes) {
        const box = doc.createElement(`div`);
        box.className = `odf-shape`;
        for (const [property, value] of Object.entries(shape.css)) {
            box.style.setProperty(property, value);
        }
        // The content sits in its own element so it can be shrunk to fit the box it was given.
        const content = doc.createElement(`div`);
        content.className = `odf-fit`;
        if (shape.image !== undefined) {
            const picture = doc.createElement(`img`);
            picture.src = shape.image.src;
            picture.alt = shape.image.alt;
            picture.loading = `lazy`;
            content.append(picture);
        }
        renderBlocks(shape.blocks, content, doc);
        box.append(content);
        stage.append(box);
    }
    const label = doc.createElement(`p`);
    label.className = `odf-slide-label`;
    label.textContent = `${index + 1}. ${slide.name}`;
    wrapper.append(stage, label);
    if (slide.notes.length > 0) {
        const notes = doc.createElement(`div`);
        notes.className = `odf-slide-notes`;
        renderBlocks(slide.notes, notes, doc);
        wrapper.append(notes);
    }
    return wrapper;
};

// What a presentation program does with a box whose contents outgrew it: shrink them until they fit, rather than
// clip a table in half. Measured once, since the whole slide is scaled as a unit afterwards.
const SMALLEST = 0.35;
const shrinkToFit = (host: HTMLElement): void => {
    for (const box of host.querySelectorAll(`.odf-shape`)) {
        const content = box.firstElementChild;
        const available = box.clientHeight;
        if (!(content instanceof HTMLElement) || available === 0 || content.scrollHeight <= available + 2) {
            continue;
        }
        const ratio = Math.max(SMALLEST, available / content.scrollHeight);
        content.style.transform = `scale(${ratio})`;
        content.style.transformOrigin = `top left`;
        content.style.width = `${100 / ratio}%`;
    }
};

const render = async (source: Blob): Promise<void> => {
    const host = container.value;
    if (host === undefined) {
        return;
    }
    const id = ++seq;
    loading.value = true;
    error.value = undefined;
    host.replaceChildren();
    try {
        const bytes = new Uint8Array(await source.arrayBuffer());
        if (id !== seq) {
            return;
        }
        release();
        open = openOdf(bytes);
        const deck = readPresentation(open);
        count.value = deck.slides.length;
        const doc = host.ownerDocument;
        deck.slides.forEach((slide, index) => host.append(slideNode(slide, index, deck.width, deck.height, doc)));
        shrinkToFit(host);
        // A slide is laid out at its true size and then scaled as one, so type, boxes and pictures keep their
        // proportions instead of each being recomputed against the pane.
        const fit = (): void => {
            const available = host.clientWidth - 48;
            host.style.setProperty(`--odf-scale`, String(Math.max(0.05, Math.min(1.6, available / (deck.width * PX_PER_CM)))));
            host.style.setProperty(`--odf-slide-height`, `${deck.height * PX_PER_CM}px`);
        };
        fit();
        observer = new ResizeObserver(fit);
        observer.observe(host);
    } catch (caught) {
        if (id !== seq) {
            return;
        }
        error.value = caught instanceof Error ? caught.message : `Could not render this presentation.`;
    } finally {
        if (id === seq) {
            loading.value = false;
        }
    }
};

onMounted(() => void render(blob));
watch(
    () => blob,
    (next) => void render(next),
);
onBeforeUnmount(() => {
    seq += 1;
    release();
});
</script>

<template>
    <div class="relative h-full min-h-0">
        <div ref="container" class="odf-deck h-full overflow-auto bg-muted/20"></div>
        <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-canvas text-muted">
            <Icon name="spinner" class="text-xl" spin />
        </div>
        <div v-else-if="error" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-danger" />
            <p class="text-sm text-danger">{{ error }}</p>
        </div>
        <div v-else-if="count === 0" class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">
            This presentation has no slides.
        </div>
    </div>
</template>

<style scoped>
.odf-deck {
    --odf-scale: 1;
    padding: 1.5rem 1.5rem 2rem;
}
.odf-deck :deep(.odf-slide-wrap) {
    margin: 0 auto 1.75rem;
    width: fit-content;
    max-width: 100%;
}
/* The stage keeps its true size for layout's sake and is scaled as a whole; the wrapper is told the scaled height so
   the slides below it do not overlap. */
.odf-deck :deep(.odf-slide) {
    position: relative;
    transform: scale(var(--odf-scale));
    transform-origin: top left;
    margin-bottom: calc(var(--odf-slide-height) * (var(--odf-scale) - 1));
    overflow: hidden;
    background: #fff;
    color: #111;
    color-scheme: light;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.3);
    font-family: sans-serif;
    font-size: 18pt;
    line-height: 1.25;
}
.odf-deck :deep(.odf-shape) {
    display: flex;
    flex-direction: column;
    justify-content: var(--odf-anchor, flex-start);
    overflow: hidden;
    box-sizing: border-box;
}
.odf-deck :deep(.odf-fit) {
    width: 100%;
}
.odf-deck :deep(.odf-shape p) {
    margin: 0;
}
.odf-deck :deep(.odf-shape img) {
    width: 100%;
    height: 100%;
    object-fit: contain;
}
.odf-deck :deep(.odf-shape ul),
.odf-deck :deep(.odf-shape ol) {
    margin: 0;
    padding-left: 1.2em;
}
.odf-deck :deep(.odf-shape table) {
    border-collapse: collapse;
    width: 100%;
}
.odf-deck :deep(.odf-shape td),
.odf-deck :deep(.odf-shape th) {
    border: 1px solid #cfcfcf;
    padding: 0.1em 0.3em;
}
.odf-deck :deep(.odf-slide-label) {
    margin: 0.4rem 0 0;
    color: var(--color-muted);
    font-size: 0.7rem;
}
.odf-deck :deep(.odf-slide-notes) {
    margin-top: 0.35rem;
    border-left: 2px solid var(--color-line);
    padding-left: 0.6rem;
    max-width: 48rem;
    color: var(--color-muted);
    font-size: 0.75rem;
}
.odf-deck :deep(.odf-slide-notes p) {
    margin: 0 0 0.2em;
}
</style>

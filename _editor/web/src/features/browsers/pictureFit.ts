import { computed, type ComputedRef, onScopeDispose, ref, type Ref, watch } from "vue";
import type { BrowserView } from "./useBrowserView";

// WHERE THE LIVE PICTURE SITS ON ITS STAGE, AND WHAT SHOWS BESIDE IT (LiveBrowser.vue). The daemon sizes the page to the
// stage, so the picture is the stage's size, except for the second a new size takes to arrive after the stage changes.
// For that second the picture being replaced sits at its own size in the stage's top-left corner, shrunk only to fit,
// never blown up, which is what a browser shows while its window is resized; and the stage beside it wears the page's
// own background, read off the picture's edges. Centred and stretched to fit instead, the old picture stood between
// black bars, or zoomed, until the new one came. A phone keeps its own fit, the handset's screen.

interface Size {
    readonly width: number;
    readonly height: number;
}

// The picture's box in CSS px for a frame of `painted` pixels at `scale` display pixels per CSS pixel on a stage of
// `stage` CSS px. Under a pixel over is the rounding between the box asked and the picture made: kept 1:1, the sliver
// clipped, rather than resampled by a fraction of a percent.
export const fitPicture = (painted: Size, scale: number, stage: Size): Size => {
    const width = painted.width / scale;
    const height = painted.height / scale;
    const withinPixel = width - stage.width < 1 && height - stage.height < 1;
    const fit = withinPixel ? 1 : Math.min(1, stage.width / width, stage.height / height);
    return { width: width * fit, height: height * fit };
};

// The stage changes every frame of a drag; the edge is read at most this often for it.
const GAP_SAMPLE_MS = 250;

export interface PictureFit {
    // The picture's box, in the stage's top-left corner; undefined fills the frame (nothing painted yet, or a phone).
    readonly box: ComputedRef<{ readonly width: string; readonly height: string } | undefined>;
    // The stage's background beside a picture smaller than it; undefined leaves the stage's own dark.
    readonly gap: ComputedRef<{ readonly backgroundColor: string } | undefined>;
    // The stage's new size in CSS px, from its ResizeObserver.
    readonly measure: (width: number, height: number) => void;
}

// The stage's box is what the daemon sizes the page's viewport to, so the picture is the page at 1:1 rather than
// scaled into whatever is left; measured via ResizeObserver, since the chrome's own text-scaled height is part of
// what's left. Each size goes to `measured`.
const observeStage = (stage: Ref<HTMLElement | null>, measured: (width: number, height: number) => void): void => {
    let observer: ResizeObserver | undefined;
    watch(stage, (element) => {
        observer?.disconnect();
        observer = undefined;
        // Null, not undefined: the stage lives under `v-if="current"`, and Vue writes null into the ref the moment that
        // element goes. `observe(null)` throws where the picture stops rather than where it is read.
        if (element === null) {
            return;
        }
        observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                measured(entry.contentRect.width, entry.contentRect.height);
            }
        });
        observer.observe(element);
    });
    onScopeDispose(() => observer?.disconnect());
};

// Sized by the frame on the canvas (`painted`) rather than the size `ready` announced, which runs ahead of it until the
// new stream's first frame decodes, so the frame being replaced is never stretched to the next one's shape. Given the
// stage, it is measured here and its size asked of the view.
export const usePictureFit = (
    view: Pick<BrowserView, `kind` | `picture` | `viewScale` | `requestSize`>,
    phone: Ref<boolean>,
    stageElement?: Ref<HTMLElement | null>,
): PictureFit => {
    const stage = ref<Size | undefined>();
    const colour = ref<string | undefined>();
    let sampledAt = 0;
    const sample = (): void => {
        sampledAt = Date.now();
        colour.value = view.picture.edgeColour();
    };
    // Each new size paints once, and its edge is read as it does; the watcher runs after the frame is drawn.
    watch(view.picture.painted, sample);
    const measure = (width: number, height: number): void => {
        stage.value = { width, height };
        if (Date.now() - sampledAt >= GAP_SAMPLE_MS) {
            sample();
        }
    };
    if (stageElement !== undefined) {
        observeStage(stageElement, (width, height) => {
            measure(width, height);
            view.requestSize(width, height);
        });
    }
    return {
        box: computed(() => {
            const painted = view.picture.painted.value;
            if (phone.value || painted === undefined || stage.value === undefined) {
                return undefined;
            }
            const fitted = fitPicture(painted, view.viewScale.value, stage.value);
            return { width: `${fitted.width}px`, height: `${fitted.height}px` };
        }),
        gap: computed(() => (colour.value === undefined || view.kind.value === `frames` || phone.value ? undefined : { backgroundColor: colour.value })),
        measure,
    };
};

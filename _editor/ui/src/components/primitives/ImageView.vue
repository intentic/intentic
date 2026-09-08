<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ImageViewState } from "./imageView.js";
import { ui } from "../../lib/ui.js";

// The one surface that draws a picture (file viewer, SVG preview, both sides of a binary diff), so zoom, pan
// and the checkerboard match everywhere. Ctrl/pinch zooms about the pointer, not the whole app; dragging pans
// instead of triggering a native image drag, which Chromium types as a file drop.

const { src, view } = defineProps<{ src: string; view?: ImageViewState }>();
// Shared view for panes that must sync zoom (e.g. a diff); only deliberate moves publish, not internal ones.
const emit = defineEmits<{ "update:view": [ImageViewState] }>();

// Zoom range and the stops the +/- controls and keyboard step through, chosen to land exactly on ½, 1:1, 2×.
const MIN_SCALE = 0.02;
const MAX_SCALE = 32;
const STOPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
// Padding kept around a fitted image so it reads as a picture, not wallpaper.
const FIT_PADDING = 16;
// Wheel delta to zoom factor: a mouse notch (~100px) lands near 1.22×; trackpad pinches stay smooth.
const WHEEL_ZOOM = 0.002;
// deltaMode 1 is lines, 2 is pages: normalised to pixels so Firefox pans/zooms at the same rate as Chrome.
const LINE_HEIGHT = 16;

const viewport = ref<HTMLElement>();
// Set once the <img> decodes; everything below is inert until then.
const natural = ref<{ readonly w: number; readonly h: number }>();
// The pane's size, observed rather than measured once, so a resize (sidebar, diff layout, window) stays fitted.
const box = ref({ w: 0, h: 0 });
const scale = ref(1);
// Offset of the image's top-left inside the pane, in pane pixels.
const offset = ref({ x: 0, y: 0 });
// True while the view is the automatic fit; any deliberate zoom clears it, so a later resize re-fits it.
const fitted = ref(true);
const dragging = ref(false);

const fitScale = computed(() => {
    const size = natural.value;
    if (size === undefined || box.value.w === 0) {
        return 1;
    }
    // Fit tops out at 1:1, so a tiny image is never blown up past its actual size.
    return Math.min(1, Math.max(box.value.w - FIT_PADDING * 2, 1) / size.w, Math.max(box.value.h - FIT_PADDING * 2, 1) / size.h);
});
const rendered = computed(() => ({ w: (natural.value?.w ?? 0) * scale.value, h: (natural.value?.h ?? 0) * scale.value }));
// Whether anything is off-screen to reach; decides the cursor and whether a plain wheel is ours or the page's.
const pannable = computed(() => rendered.value.w > box.value.w + 1 || rendered.value.h > box.value.h + 1);
const percent = computed(() => Math.round(scale.value * 100));
const atNatural = computed(() => Math.abs(scale.value - 1) < 0.005);

const clampScale = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

// The single writer of the view: clamps scale and keeps the image reachable, centred where it's smaller
// than the pane, flush to the edges where it's bigger. `publish=false` for the pane's own moves (fit, resize).
const place = (nextScale: number, x: number, y: number, publish = true): void => {
    const size = natural.value;
    if (size === undefined) {
        return;
    }
    const value = clampScale(nextScale);
    const w = size.w * value;
    const h = size.h * value;
    scale.value = value;
    offset.value = {
        x: w <= box.value.w ? (box.value.w - w) / 2 : Math.min(0, Math.max(box.value.w - w, x)),
        y: h <= box.value.h ? (box.value.h - h) / 2 : Math.min(0, Math.max(box.value.h - h, y)),
    };
    if (publish && view !== undefined) {
        emit(`update:view`, { fit: false, scale: value, x: offset.value.x, y: offset.value.y });
    }
};

// Fitting publishes as `fit: true`, not the computed scale: a sibling with a differently sized image has
// its own whole-picture scale.
const fit = (publish = true): void => {
    place(fitScale.value, 0, 0, false);
    fitted.value = true;
    if (publish && view !== undefined && !view.fit) {
        emit(`update:view`, { fit: true });
    }
};

// Zooms keeping the image point under (clientX, clientY) pinned, which is what makes it feel like a magnifier.
const zoomAround = (nextScale: number, clientX: number, clientY: number): void => {
    const rect = viewport.value?.getBoundingClientRect();
    if (rect === undefined) {
        return;
    }
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const factor = clampScale(nextScale) / scale.value;
    fitted.value = false;
    place(clampScale(nextScale), px - (px - offset.value.x) * factor, py - (py - offset.value.y) * factor);
};

// Controls and keyboard zoom about the pane's centre; there's no pointer position to pin to.
const zoomCentre = (nextScale: number): void => {
    const rect = viewport.value?.getBoundingClientRect();
    if (rect !== undefined) {
        zoomAround(nextScale, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
};
const nextStop = (direction: 1 | -1): number | undefined =>
    (direction === 1 ? STOPS : STOPS.toReversed()).find((stop) => (direction === 1 ? stop > scale.value + 0.001 : stop < scale.value - 0.001));
const step = (direction: 1 | -1): void => {
    const stop = nextStop(direction);
    if (stop !== undefined) {
        zoomCentre(stop);
    }
};

const pixels = (delta: number, mode: number, page: number): number => (mode === 0 ? delta : mode === 1 ? delta * LINE_HEIGHT : delta * page);

const onWheel = (event: WheelEvent): void => {
    if (natural.value === undefined) {
        return;
    }
    const dy = pixels(event.deltaY, event.deltaMode, box.value.h);
    // Ctrl/⌘ (or a trackpad pinch) means zoom; prevented, or the browser would scale the whole app instead.
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomAround(scale.value * Math.exp(-dy * WHEEL_ZOOM), event.clientX, event.clientY);
        return;
    }
    // Nothing off-screen: leave the wheel to whatever scroller this pane sits in (e.g. a stacked binary diff).
    if (!pannable.value) {
        return;
    }
    event.preventDefault();
    const dx = pixels(event.deltaX, event.deltaMode, box.value.w);
    // Shift+wheel is the horizontal axis, for a mouse with only a vertical wheel.
    place(scale.value, offset.value.x - (event.shiftKey ? dy : dx), offset.value.y - (event.shiftKey ? 0 : dy));
};

// Live pointers, so one finger pans and two pinch; kept as a map since pointer ids aren't indices.
const pointers = new Map<number, { x: number; y: number }>();
let pinchSpan: number | undefined;

const onPointerDown = (event: PointerEvent): void => {
    if (natural.value === undefined || event.button !== 0) {
        return;
    }
    // Cancels the native image-drag and text-selection drag; this gesture is a pan now. Focus is taken
    // explicitly, since preventDefault would otherwise block it.
    event.preventDefault();
    viewport.value?.focus();
    viewport.value?.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragging.value = true;
};

const onPointerMove = (event: PointerEvent): void => {
    const previous = pointers.get(event.pointerId);
    if (previous === undefined) {
        return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [a, b] = [...pointers.values()];
    if (a !== undefined && b !== undefined) {
        const span = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchSpan !== undefined && pinchSpan > 0) {
            // Anchoring on the live midpoint makes the pinch pan as it zooms, matching what fingers expect.
            zoomAround(scale.value * (span / pinchSpan), (a.x + b.x) / 2, (a.y + b.y) / 2);
        }
        pinchSpan = span;
        return;
    }
    place(scale.value, offset.value.x + event.clientX - previous.x, offset.value.y + event.clientY - previous.y);
};

const onPointerUp = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    // Forget the pinch span regardless of which finger lifted, so the one left behind resumes panning rather than
    // jumping.
    pinchSpan = undefined;
    dragging.value = pointers.size > 0;
};

// Flips between the whole picture and a close look: fit to 1:1 (or 2× if fit is already 1:1, for a small
// image), and back to fit from anywhere else.
const onDoubleClick = (event: MouseEvent): void => {
    if (!fitted.value) {
        fit();
        return;
    }
    zoomAround(fitScale.value < 1 ? 1 : 2, event.clientX, event.clientY);
};

const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key.startsWith(`Arrow`)) {
        event.preventDefault();
        const nudge = event.shiftKey ? 200 : 60;
        const dx = event.key === `ArrowLeft` ? nudge : event.key === `ArrowRight` ? -nudge : 0;
        const dy = event.key === `ArrowUp` ? nudge : event.key === `ArrowDown` ? -nudge : 0;
        place(scale.value, offset.value.x + dx, offset.value.y + dy);
        return;
    }
    switch (event.key) {
        case `+`:
        case `=`:
            step(1);
            break;
        case `-`:
        case `_`:
            step(-1);
            break;
        case `0`:
            fit();
            break;
        case `1`:
            zoomCentre(1);
            break;
        default:
            return;
    }
    event.preventDefault();
};

// A picture that lands while a bound sibling is already zoomed joins it there rather than resetting: a
// late-arriving diff side must not undo where the reviewer already looked.
const onLoad = (event: Event): void => {
    const image = event.target as HTMLImageElement;
    natural.value = { w: image.naturalWidth, h: image.naturalHeight };
    if (view === undefined || view.fit) {
        fit(false);
        return;
    }
    fitted.value = false;
    place(view.scale, view.x, view.y, false);
};

// A new file resets the view; otherwise it would inherit the previous image's magnification.
watch(
    () => src,
    () => {
        natural.value = undefined;
        fitted.value = true;
        scale.value = 1;
        offset.value = { x: 0, y: 0 };
    },
);

// Applies the sibling pane's move, never echoing it (see `place`), so two bound panes settle in one hop
// instead of answering each other.
watch(
    () => view,
    (next) => {
        if (next === undefined || natural.value === undefined) {
            return;
        }
        if (next.fit) {
            if (!fitted.value) {
                fit(false);
            }
            return;
        }
        if (scale.value === next.scale && offset.value.x === next.x && offset.value.y === next.y) {
            return;
        }
        fitted.value = false;
        place(next.scale, next.x, next.y, false);
    },
);

let observer: ResizeObserver | undefined;
onBeforeUnmount(() => observer?.disconnect());
watch(viewport, (element) => {
    observer?.disconnect();
    if (element === undefined) {
        return;
    }
    observer = new ResizeObserver(() => {
        box.value = { w: element.clientWidth, h: element.clientHeight };
        // A fitted image re-fits; a zoomed one keeps its scale and is only pulled back into reach. Neither
        // publishes: a resize isn't the reviewer's doing.
        if (fitted.value) {
            fit(false);
            return;
        }
        place(scale.value, offset.value.x, offset.value.y, false);
    });
    observer.observe(element);
});

const imageStyle = computed(() => {
    const size = natural.value;
    if (size === undefined) {
        return { visibility: `hidden` as const };
    }
    return {
        width: `${size.w}px`,
        height: `${size.h}px`,
        transform: `translate3d(${offset.value.x}px, ${offset.value.y}px, 0) scale(${scale.value})`,
        // Past 2× the pixel grid itself is the point (a screenshot, an icon), so stop interpolating it away.
        imageRendering: scale.value >= 2 ? (`pixelated` as const) : (`auto` as const),
    };
});
// Hidden below 340px, so a narrow pane (e.g. half a diff) drops dimensions before the controls beside them.
const showDimensions = computed(() => natural.value !== undefined && box.value.w > 340);
</script>

<template>
    <div
        ref="viewport"
        class="image-checker group relative h-full w-full touch-none select-none overflow-hidden outline-none"
        :class="dragging ? `cursor-grabbing` : pannable ? `cursor-grab` : `cursor-default`"
        tabindex="0"
        role="group"
        aria-label="Image preview: Ctrl and scroll to zoom, drag to pan"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="onDoubleClick"
        @keydown="onKeyDown"
    >
        <img :src="src" alt="" draggable="false" class="absolute left-0 top-0 max-w-none origin-top-left" :style="imageStyle" @load="onLoad" />

        <!--
            Dimmed until the pointer is in the pane, so the controls never compete with the picture. `pointerdown.stop`
            keeps a click on them from starting a pan; `mousedown.prevent` keeps focus on the surface so keys still
            work.
        -->
        <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
            <div
                v-if="natural"
                class="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-line bg-card/90 px-1 py-0.5 text-2xs text-muted opacity-60 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                @pointerdown.stop
                @dblclick.stop
            >
                <span v-if="showDimensions" class="px-1.5 tabular-nums text-subtle">{{ natural.w }} × {{ natural.h }}</span>
                <button
                    type="button"
                    :class="ui.iconButton(`h-5 w-5 rounded text-sm leading-none`)"
                    :disabled="nextStop(-1) === undefined"
                    v-tooltip.top="'Zoom out (−)'"
                    aria-label="Zoom out"
                    @mousedown.prevent
                    @click="step(-1)"
                >
                    −
                </button>
                <span
                    class="w-10 cursor-help text-center tabular-nums text-content"
                    v-tooltip.top="'Ctrl + scroll to zoom · drag to pan · double-click to fit'"
                >
                    {{ percent }}%
                </span>
                <button
                    type="button"
                    :class="ui.iconButton(`h-5 w-5 rounded text-sm leading-none`)"
                    :disabled="nextStop(1) === undefined"
                    v-tooltip.top="'Zoom in (+)'"
                    aria-label="Zoom in"
                    @mousedown.prevent
                    @click="step(1)"
                >
                    +
                </button>
                <span class="mx-0.5 h-3.5 w-px bg-line"></span>
                <button
                    type="button"
                    :class="ui.iconButton(`h-5 w-auto rounded px-1.5`)"
                    :disabled="fitted"
                    v-tooltip.top="'Fit to the pane (0)'"
                    @mousedown.prevent
                    @click="fit()"
                >
                    Fit
                </button>
                <button
                    type="button"
                    :class="ui.iconButton(`h-5 w-auto rounded px-1.5 tabular-nums`)"
                    :disabled="atNatural"
                    v-tooltip.top="'Actual size (1)'"
                    @mousedown.prevent
                    @click="zoomCentre(1)"
                >
                    1:1
                </button>
            </div>
        </div>
    </div>
</template>

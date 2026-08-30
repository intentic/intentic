<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ImageViewState } from "./imageView.js";
import { ui } from "../lib/ui.js";

/* THE ONE SURFACE THAT SHOWS A PICTURE: the file viewer's images, the SVG preview and both sides of a binary
 * diff all render through here, so zoom, pan and the transparency checkerboard behave identically wherever an
 * image appears. Two behaviours forced a component where an <img> in a scroller used to do:
 *
 * ZOOM. An image is opened to look closely at something inside it, and the only zoom within reach of a plain
 * <img> is the browser's own Ctrl+scroll, which scales the whole application (tab strip, tree, chat) and
 * leaves the picture exactly as large, relative to its pane, as it was. Ctrl+scroll is taken here instead:
 * preventDefault keeps it from the browser, and it magnifies about the POINTER, so whatever is under the cursor
 * stays under the cursor. A trackpad pinch arrives as the same event, so pinching works for free. Plain scroll
 * pans once there is something off-screen to pan to, and is left to the page otherwise.
 *
 * THE GHOST DRAG. Every <img> is a drag source by default, and Chromium types the payload of an in-page image
 * drag as `Files`: indistinguishable, at a drop target, from a file dragged in off the desktop. So grabbing
 * the picture to move it raised the workspace's "drop files to add to the workspace root" hint, and letting go
 * uploaded a copy of the file being LOOKED at into the repo root. Here the grab IS the pan: the image is
 * draggable=false and pointerdown is prevented, so no native drag can start. (WorkspaceDesktop also declines
 * drags that began inside the document: same bug, reachable from an image in a markdown preview.)
 *
 * The picture is drawn at its natural size and moved by a transform, not laid out inside a scroller: one
 * compositor property carries both zoom and pan, so a wheel gesture never reflows the pane. */

const { src, view } = defineProps<{ src: string; view?: ImageViewState }>();
/* THE VIEW, WHEN SOMETHING ELSE OWNS IT. Optional: on its own this component keeps its magnification to
 * itself, which is right for the one image in a file tab. Two panes comparing two versions of one picture are
 * the exception (BinaryDiffView), and there a private view is the bug: whatever the reviewer zooms into on the
 * left has to appear on the right or there is nothing to compare. Bound both ways, the parent holds one state
 * and hands it to both panes.
 *
 * Only DELIBERATE moves are published, never the ones this pane made on its own behalf, which is what keeps
 * two bound panes from talking each other into a corner: an incoming view is applied without being echoed, and
 * a re-fit forced by a pane resize is not a gesture. */
const emit = defineEmits<{ "update:view": [ImageViewState] }>();

// Zoom range, and the ladder the +/− controls and the keyboard step through: stops rather than a fixed
// multiplier, so the magnifications worth landing on exactly (½, 1:1, 2×) are always hit and never stepped past.
const MIN_SCALE = 0.02;
const MAX_SCALE = 32;
const STOPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
// Breathing room left around a fitted image, so it reads as a picture in a pane rather than a wallpaper.
const FIT_PADDING = 16;
// Wheel delta → zoom factor. A mouse notch (~100px) lands on ~1.22×; a trackpad pinch's small deltas stay smooth.
const WHEEL_ZOOM = 0.002;
// deltaMode 1 is lines, 2 is pages: normalise both to pixels so Firefox pans and zooms at the same rate.
const LINE_HEIGHT = 16;

const viewport = ref<HTMLElement>();
// Set from the <img> once it decodes; everything below is inert until then.
const natural = ref<{ readonly w: number; readonly h: number }>();
// The pane's size, observed rather than measured once: the sidebar resizes, the diff flips split↔unified, the
// window changes, and a fitted image should still be fitted afterwards.
const box = ref({ w: 0, h: 0 });
const scale = ref(1);
// Offset of the image's top-left inside the pane, in pane pixels (transform-origin is the corner).
const offset = ref({ x: 0, y: 0 });
// True while the view is the automatic one, so a pane resize re-fits instead of preserving a scale nobody chose.
// Any deliberate zoom clears it.
const fitted = ref(true);
const dragging = ref(false);

const fitScale = computed(() => {
    const size = natural.value;
    if (size === undefined || box.value.w === 0) {
        return 1;
    }
    // Never blow a 16px favicon up to fill the pane: "fit" tops out at 1:1, which is that icon's honest size.
    return Math.min(1, Math.max(box.value.w - FIT_PADDING * 2, 1) / size.w, Math.max(box.value.h - FIT_PADDING * 2, 1) / size.h);
});
const rendered = computed(() => ({ w: (natural.value?.w ?? 0) * scale.value, h: (natural.value?.h ?? 0) * scale.value }));
// Is there anything off-screen to reach? Decides the cursor, and whether a plain wheel is ours or the page's.
const pannable = computed(() => rendered.value.w > box.value.w + 1 || rendered.value.h > box.value.h + 1);
const percent = computed(() => Math.round(scale.value * 100));
const atNatural = computed(() => Math.abs(scale.value - 1) < 0.005);

const clampScale = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

// The single writer of the view: clamps the scale, then keeps the image reachable, centred on any axis where it
// is smaller than the pane, and flush to the edges on any axis where it is bigger, so it can never be flung into
// the void and lost.
//
// `publish` marks a move the reviewer asked for, the only kind a bound sibling should follow. Everything this
// pane does for its own reasons (adopting the shared view, re-fitting after a resize) passes false.
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

// Fitting is published as "fit", not as the number it worked out to: a sibling pane holding a differently sized
// version of the picture has its own whole-picture scale, and copying this one's would crop or shrink it.
const fit = (publish = true): void => {
    place(fitScale.value, 0, 0, false);
    fitted.value = true;
    if (publish && view !== undefined && !view.fit) {
        emit(`update:view`, { fit: true });
    }
};

// Zoom keeping the image point under (clientX, clientY) pinned there: the reason a magnifier feels like one.
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

// The controls and the keyboard zoom about the pane's centre: there is no pointer to pin to.
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
    // Ctrl/⌘ (and the trackpad pinch that synthesises it) means zoom. Prevented, or the browser scales the app.
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomAround(scale.value * Math.exp(-dy * WHEEL_ZOOM), event.clientX, event.clientY);
        return;
    }
    // Nothing off-screen: leave the wheel to whatever scroller this pane sits in (the stacked binary diff).
    if (!pannable.value) {
        return;
    }
    event.preventDefault();
    const dx = pixels(event.deltaX, event.deltaMode, box.value.w);
    // Shift+wheel is the horizontal axis on a mouse that only has the one.
    place(scale.value, offset.value.x - (event.shiftKey ? dy : dx), offset.value.y - (event.shiftKey ? 0 : dy));
};

// Live pointers, so one finger pans and two pinch. Kept as a map because pointer ids are not indices.
const pointers = new Map<number, { x: number; y: number }>();
let pinchSpan: number | undefined;

const onPointerDown = (event: PointerEvent): void => {
    if (natural.value === undefined || event.button !== 0) {
        return;
    }
    // Cancels the browser's native image drag AND the text-selection drag: this gesture is a pan now. Focus is
    // taken explicitly because preventDefault would otherwise deny it, and the keyboard shortcuts need it.
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
            // Anchoring on the live midpoint makes the pinch pan as it zooms, which is what fingers expect.
            zoomAround(scale.value * (span / pinchSpan), (a.x + b.x) / 2, (a.y + b.y) / 2);
        }
        pinchSpan = span;
        return;
    }
    place(scale.value, offset.value.x + event.clientX - previous.x, offset.value.y + event.clientY - previous.y);
};

const onPointerUp = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    // Forget the span whichever finger lifted, so the one left behind resumes panning instead of jumping.
    pinchSpan = undefined;
    dragging.value = pointers.size > 0;
};

// Double-click flips between the whole picture and a close look, as every image viewer does: from fit to 1:1
// (or 2× when fit already IS 1:1, for an image smaller than the pane), and from anywhere else back to fit.
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

// A picture that lands while a bound sibling is already zoomed in joins it there rather than starting whole:
// the second side of a diff arriving late must not undo where the reviewer has just looked.
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

// A new file in the same pane starts over: otherwise the next image inherits the last one's magnification.
watch(
    () => src,
    () => {
        natural.value = undefined;
        fitted.value = true;
        scale.value = 1;
        offset.value = { x: 0, y: 0 };
    },
);

// The other pane moved. Applied, never echoed (see `place`), so two bound panes settle in one hop instead of
// answering each other's answer.
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
        // A fitted image re-fits; a deliberately zoomed one keeps its scale and is only pulled back into reach.
        // Neither is published: a pane changing size is the window's doing, not the reviewer's.
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
        // Past 2× the interesting thing IS the pixel grid (a screenshot, an icon), so stop interpolating it away.
        imageRendering: scale.value >= 2 ? (`pixelated` as const) : (`auto` as const),
    };
});
// The pane can be half a diff on a narrow window: drop the dimensions before the controls they sit beside.
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

        <!-- Zoom controls: dimmed until the pointer is in the pane, so they never compete with the picture, and
             the only place the gestures are written down. `pointerdown.stop` keeps a press on them from starting
             a pan behind them; `mousedown.prevent` leaves focus on the surface so the keys keep working. -->
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

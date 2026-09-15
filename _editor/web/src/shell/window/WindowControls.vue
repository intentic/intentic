<script setup lang="ts">
import { useTheme } from "@intentic/ui";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { announceDesktopMode, DESKTOP_WINDOW_EVENT, type DesktopWindowEvent, desktopFrameless, workDesktopWindow } from "../../app/environments/desktop";
import { BAR, type BarEdges, barsChanged, type Corner, cornerBar } from "./controlsReserve";
import { domLayout, pressOf, windowGesture } from "./windowGesture";

/* THE WINDOW'S OWN THREE BUTTONS, FLOATING IN THE TOP-RIGHT CORNER OF A WINDOW THAT HAS NO FRAME — and the page under
   them read as the handle the frame used to be (windowGesture.ts). Nothing else is drawn: no bar, no strip, no fill. */

const frameless = desktopFrameless();
const maximized = ref(false);
const controls = ref<HTMLElement>();
/* The app's own screens follow this page's light; it cannot see this window's storage, so the scheme is announced. */
const { scheme } = useTheme();
const route = useRoute();

/* --- The corner ---------------------------------------------------------------------------------------------- */

/* Measured rather than declared: which bar ends at the window's right edge is a fact about the layout (controlsReserve.ts). */
const RESERVE = `padding-inline-end`;
let reserved: HTMLElement | undefined;
let scheduled = 0;

/* THE BARS, WATCHED FOR MOVING. */
let observer: ResizeObserver | undefined;
const watched = new Set<Element>();

/* THE DOCUMENT, WATCHED FOR BARS ARRIVING AND LEAVING. */
let arrivals: MutationObserver | undefined;

const watchBars = (bars: readonly HTMLElement[]): void => {
    if (observer === undefined) {
        return;
    }
    for (const bar of watched) {
        if (!bars.includes(bar as HTMLElement)) {
            observer.unobserve(bar);
            watched.delete(bar);
        }
    }
    for (const bar of bars) {
        if (!watched.has(bar)) {
            observer.observe(bar);
            watched.add(bar);
        }
    }
};

/// Where a bar that somehow has no box counts as being: outside the band, short of the corner.
const NOWHERE: BarEdges = { top: Number.POSITIVE_INFINITY, bottom: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };

/* The buttons' own box, which is both the corner a bar gives up and the band along the top edge that drags. */
const cornerOf = (): Corner => {
    const box = controls.value?.getBoundingClientRect();
    return box === undefined ? { left: Number.POSITIVE_INFINITY, bottom: 0 } : { left: box.left, bottom: box.bottom };
};

const measure = (): void => {
    scheduled = 0;
    const bars = [...document.querySelectorAll<HTMLElement>(BAR)];
    // One box per bar, read once: `getBoundingClientRect` is a layout flush, and this runs on resize frames.
    const boxes = new Map<HTMLElement, BarEdges>(bars.map((bar) => [bar, bar.getBoundingClientRect()]));
    watchBars(bars);
    const corner = cornerBar(bars, (bar) => boxes.get(bar) ?? NOWHERE, cornerOf());
    if (corner === reserved) {
        return;
    }
    reserved?.style.removeProperty(RESERVE);
    corner?.style.setProperty(RESERVE, `var(--window-controls-width)`);
    reserved = corner;
};

/* One measurement per frame at most, and only after something that can have moved a bar: the window resizing, a bar resizing (the observer above). */
const schedule = (): void => {
    if (scheduled === 0) {
        scheduled = requestAnimationFrame(measure);
    }
};

// A bar arrives with its own controls at its right end, and every view mounts through a dynamic import (asyncView),
// so none of the events below is still pending when its bars land. Measured on the spot rather than on the next
// frame: this runs at the microtask checkpoint after the patch that inserted the bar, still before that patch is
// painted, so no frame paints a bar's control under the window's buttons.
const onArrivals = (records: MutationRecord[]): void => {
    if (!barsChanged(records)) {
        return;
    }
    if (scheduled !== 0) {
        cancelAnimationFrame(scheduled);
    }
    measure();
};

/* --- The page as the handle ---------------------------------------------------------------------------------- */

const onPress = (event: MouseEvent): void => {
    // The primary button only: a right-press anywhere is that place's own context menu.
    if (event.button !== 0) {
        return;
    }
    const gesture = windowGesture(pressOf(event), domLayout(cornerOf().bottom));
    if (gesture !== undefined) {
        // The gesture IS the verb: both names are the app's own (environments/desktop.ts `DesktopWindowVerb`).
        workDesktopWindow(gesture);
    }
};

// What the window is doing to itself, which is most of what happens to it: Win+↑, a drag to the top edge, a
// snap layout, the platform's own restore. The glyph follows the window rather than the presses on this page.
const onWindowEvent = (event: Event): void => {
    maximized.value = (event as CustomEvent<DesktopWindowEvent>).detail?.maximized === true;
};

let stopWatching: (() => void) | undefined;
let stopAnnouncing: (() => void) | undefined;

onMounted(() => {
    if (!frameless) {
        return;
    }
    // What turns the reserve on for every bar in this window, and clears the corner on the entry screens (styles.css, entry.css).
    document.documentElement.setAttribute(`data-frameless`, ``);
    observer = typeof ResizeObserver === `undefined` ? undefined : new ResizeObserver(schedule);
    arrivals = typeof MutationObserver === `undefined` ? undefined : new MutationObserver(onArrivals);
    arrivals?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener(DESKTOP_WINDOW_EVENT, onWindowEvent);
    // Capture, because a surface's own handlers may stop a press from bubbling, and a window that cannot be
    // moved from part of its background is a window that feels stuck.
    window.addEventListener(`mousedown`, onPress, true);
    window.addEventListener(`resize`, schedule);
    window.addEventListener(`click`, schedule, true);
    window.addEventListener(`keyup`, schedule, true);
    stopWatching = watch(() => route.fullPath, schedule);
    schedule();
    /* The app is waiting to hear this. */
    workDesktopWindow(`ready`);
    announceDesktopMode(scheme.value);
    stopAnnouncing = watch(scheme, (next) => announceDesktopMode(next));
});

onUnmounted(() => {
    if (!frameless) {
        return;
    }
    document.documentElement.removeAttribute(`data-frameless`);
    observer?.disconnect();
    observer = undefined;
    watched.clear();
    arrivals?.disconnect();
    arrivals = undefined;
    window.removeEventListener(DESKTOP_WINDOW_EVENT, onWindowEvent);
    window.removeEventListener(`mousedown`, onPress, true);
    window.removeEventListener(`resize`, schedule);
    window.removeEventListener(`click`, schedule, true);
    window.removeEventListener(`keyup`, schedule, true);
    stopWatching?.();
    stopAnnouncing?.();
    if (scheduled !== 0) {
        cancelAnimationFrame(scheduled);
    }
    reserved?.style.removeProperty(RESERVE);
    reserved = undefined;
});
</script>

<template>
<!-- Fixed to the viewport, which is what keeps a press on them from being the window's (windowGesture.ts `inOverlay`). -->
    <div v-if="frameless" ref="controls" class="window-controls">
        <button type="button" class="window-control" aria-label="Minimise" @click="workDesktopWindow(`minimize`)">
            <Icon name="minus" class="text-sm" />
        </button>
        <button type="button" class="window-control" :aria-label="maximized ? `Restore` : `Maximise`" @click="workDesktopWindow(`maximize`)">
            <Icon :name="maximized ? `restore` : `square`" class="text-sm" />
        </button>
        <button type="button" class="window-control window-control-close" aria-label="Close" @click="workDesktopWindow(`close`)">
            <Icon name="times" class="text-sm" />
        </button>
    </div>
</template>

<style scoped>
/* Over whatever the layout put in the corner, on no ground of their own: the bar that ends there keeps this much of itself clear (controlsReserve.ts). */
.window-controls {
    position: fixed;
    inset-block-start: 0;
    inset-inline-end: 0;
    z-index: 40;
    display: flex;
    height: var(--bar-height);
}

/* Each control fills the band's height for a reliable corner target. */
.window-control {
    display: flex;
    width: 2.5rem;
    align-items: center;
    justify-content: center;
    color: var(--color-muted);
    transition:
        background-color 120ms ease,
        color 120ms ease;
}

.window-control:hover {
    background: var(--color-overlay);
    color: var(--color-content);
}

/* The close control is red only while hovered. */
.window-control-close:hover {
    background: var(--color-danger-600);
    color: var(--color-danger-0);
}

.window-control:focus-visible {
    outline: 1px solid var(--color-primary-500);
    outline-offset: -2px;
}
</style>

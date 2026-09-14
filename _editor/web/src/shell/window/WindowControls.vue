<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { DESKTOP_WINDOW_EVENT, type DesktopWindowEvent, desktopFrameless, workDesktopWindow } from "../../app/environments/desktop";
import { BAR, type BarEdges, edgeBar, TITLE_BAR, titleBarGesture, topRow } from "./titleBar";

/* THE WINDOW'S OWN THREE BUTTONS, IN THE ROW THIS APP ALREADY DRAWS — AND THAT ROW DRESSED AS A TITLE BAR. */

const frameless = desktopFrameless();
const maximized = ref(false);
/* No bar stands in the top row, so the strip does (titleBar.ts `STRIP`). */
const bare = ref(false);
const route = useRoute();

/* Measured rather than declared: which bars stand in the top row, and which of them ends at the window's right edge, are facts about the layout. */
const RESERVE = `padding-inline-end`;
let reserved: HTMLElement | undefined;
let scheduled = 0;

/* THE BARS, WATCHED FOR MOVING. */
let observer: ResizeObserver | undefined;
const watched = new Set<Element>();

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

/// Where a bar that somehow has no box counts as being: in no row, at no edge.
const NOWHERE: BarEdges = { top: Number.POSITIVE_INFINITY, right: Number.NEGATIVE_INFINITY };

const measure = (): void => {
    scheduled = 0;
    const bars = [...document.querySelectorAll<HTMLElement>(BAR)];
    // One box per bar, read once: `getBoundingClientRect` is a layout flush, and this runs on resize frames.
    const boxes = new Map<HTMLElement, BarEdges>(bars.map((bar) => [bar, bar.getBoundingClientRect()]));
    const edgesOf = (bar: HTMLElement): BarEdges => boxes.get(bar) ?? NOWHERE;
    const row = topRow(bars, edgesOf);
    // The title fill goes on every bar standing in the top row and comes off every bar that has left it. With
    // the force flag `toggleAttribute` is a no-op when nothing changed, so a quiet frame costs no style work.
    for (const bar of bars) {
        bar.toggleAttribute(TITLE_BAR, row.includes(bar));
    }
    bare.value = row.length === 0;
    watchBars(bars);
    // `clientWidth`, not `innerWidth`: a page with a scrollbar of its own would otherwise measure the window as
    // wider than the widest a bar in it can be, and reserve nothing.
    const edge = edgeBar(bars, edgesOf, document.documentElement.clientWidth);
    if (edge === reserved) {
        return;
    }
    reserved?.style.removeProperty(RESERVE);
    edge?.style.setProperty(RESERVE, `var(--window-controls-width)`);
    reserved = edge;
};

/* One measurement per frame at most, and only after something that can have moved a bar: the window resizing, a bar resizing (the observer above). */
const schedule = (): void => {
    if (scheduled === 0) {
        scheduled = requestAnimationFrame(measure);
    }
};

/* --- The bar as a title bar ---------------------------------------------------------------------------- */

/* `mousedown`, not `pointerdown`: a pointer event's `detail` is 0 by specification, and `detail` is how many clicks deep this press is. */
const onPress = (event: MouseEvent): void => {
    // The primary button only: a right-click in the row is the row's own context menu (the chat's bar has one).
    if (event.button !== 0) {
        return;
    }
    const gesture = titleBarGesture(event.target as Element | null, event.detail, (bar) => bar.getBoundingClientRect().top);
    if (gesture !== undefined) {
        // The gesture IS the verb: both names are the app's own (environments/desktop.ts `DesktopWindowVerb`).
        workDesktopWindow(gesture);
    }
};

// What the window is doing to itself, which is most of what happens to it: Win+↑, a drag to the top edge, a
// snap layout, the platform's own restore. The glyph follows the window rather than the presses on this bar.
const onWindowEvent = (event: Event): void => {
    maximized.value = (event as CustomEvent<DesktopWindowEvent>).detail?.maximized === true;
};

let stopWatching: (() => void) | undefined;

onMounted(() => {
    if (!frameless) {
        return;
    }
    // What turns the reserve on for every bar in this window (styles.css).
    document.documentElement.setAttribute(`data-frameless`, ``);
    observer = typeof ResizeObserver === `undefined` ? undefined : new ResizeObserver(schedule);
    window.addEventListener(DESKTOP_WINDOW_EVENT, onWindowEvent);
    // Capture, because a bar's own handlers may stop a press from bubbling, and a window that cannot be
    // dragged from part of its title bar is a window with a broken title bar.
    window.addEventListener(`mousedown`, onPress, true);
    window.addEventListener(`resize`, schedule);
    window.addEventListener(`click`, schedule, true);
    window.addEventListener(`keyup`, schedule, true);
    stopWatching = watch(() => route.fullPath, schedule);
    schedule();
/* The app is waiting to hear this. */
    workDesktopWindow(`ready`);
});

onUnmounted(() => {
    if (!frameless) {
        return;
    }
    document.documentElement.removeAttribute(`data-frameless`);
    observer?.disconnect();
    observer = undefined;
    watched.clear();
    window.removeEventListener(DESKTOP_WINDOW_EVENT, onWindowEvent);
    window.removeEventListener(`mousedown`, onPress, true);
    window.removeEventListener(`resize`, schedule);
    window.removeEventListener(`click`, schedule, true);
    window.removeEventListener(`keyup`, schedule, true);
    stopWatching?.();
    if (scheduled !== 0) {
        cancelAnimationFrame(scheduled);
    }
    reserved?.style.removeProperty(RESERVE);
    reserved = undefined;
    for (const bar of document.querySelectorAll(`[${TITLE_BAR}]`)) {
        bar.removeAttribute(TITLE_BAR);
    }
});
</script>

<template>
    <template v-if="frameless">
<!-- THE BAR OF LAST RESORT (titleBar.ts `STRIP`): the full width of the window, exactly as tall as the row it stands in for. -->
        <div v-if="bare" class="window-titlebar" aria-hidden="true"></div>
<!-- Window controls disable dragging because the strip contains buttons. -->
        <div class="window-controls" data-window-no-drag>
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
</template>

<style scoped>
/* The strip paints from the same two properties the bars do (styles.css `--title-bar-fill`, `--title-bar-shadow`). */
.window-titlebar {
    position: fixed;
    inset-block-start: 0;
    inset-inline: 0;
    z-index: 39;
    height: var(--bar-height);
    background: var(--title-bar-fill);
    border-block-end: 1px solid var(--color-line);
    box-shadow: var(--title-bar-shadow);
}

/* Window controls overlay the reserved title-bar row. */
.window-controls {
    position: fixed;
    inset-block-start: 0;
    inset-inline-end: 0;
    z-index: 40;
    display: flex;
    height: var(--bar-height);
    background-color: var(--title-bar-fill);
    background-image: none;
    border-block-end: 1px solid var(--color-line);
}

/* Each control fills the title-bar height for a reliable corner target. */
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

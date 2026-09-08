<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { DESKTOP_WINDOW_EVENT, type DesktopWindowEvent, desktopFrameless, workDesktopWindow } from "../../app/environments/desktop";
import { BAR, type BarEdges, edgeBar, TITLE_BAR, titleBarGesture, topRow } from "./titleBar";

/* THE WINDOW'S OWN THREE BUTTONS, IN THE ROW THIS APP ALREADY DRAWS — AND THAT ROW DRESSED AS A TITLE BAR.
 *
 * The desktop app's window has no platform title bar (desktop-app windows.rs). What that strip carried was a
 * logo, a name and minimise/maximise/close — a full row of screen above a product whose own top row is
 * already a full-width bar, with the logo and the name each said twice over (the taskbar, the rail's sandbox
 * chip). So the row does both jobs now: the columns keep their controls, the window's three go at its right
 * end, and every empty stretch of it drags the window.
 *
 * IT HAS TO LOOK LIKE ONE, TOO. A row of bars that merely functions as a title bar is a row of bars: the
 * explorer's on canvas, the editor's on card, the chat's on canvas again, and on a screen with no bar at all
 * three buttons floating over a painting. So the bars standing in the top row wear the title fill and its
 * shadow (`data-title-bar`, styles.css), and a screen with no bar in its top row — the login page, a gate, an
 * error — gets a strip drawn in their place (titleBar.ts `STRIP`), which drags and double-clicks like any bar.
 *
 * MOUNTED AT THE APP'S ROOT rather than in the desktop shell, for the reason NotificationHost is: this is true
 * of every screen in the window. A login page, the sandbox gate, an error state, and the mobile chrome a
 * narrow window gets are all screens somebody has to be able to close the app from, and a control that lived
 * in ShellDesktop would strand every one of them.
 *
 * IT DRAWS NOTHING ANYWHERE ELSE. `frameless` is a word the app injects into the page (environments/desktop),
 * so a browser tab renders none of this — and neither does an older build of the app, whose window still has
 * a frame of its own. The two ship separately, and that is exactly what keeps a page newer than its app from
 * putting a second set of buttons under the first.
 *
 * NO IPC, HERE OR ANYWHERE IN THIS WINDOW: every press is an `intentic://window` navigation the app
 * intercepts in Rust, including the drag, which is handed to the platform's own move loop from there. None of
 * those navigations may start before the document has loaded — see `openDesktopLink` for the page that cost. */

const frameless = desktopFrameless();
const maximized = ref(false);
/* No bar stands in the top row, so the strip does (titleBar.ts `STRIP`). Off until measured: a strip flashed
 * over the workspace's bars for a frame would be worse than a login page with a bare corner for one. */
const bare = ref(false);
const route = useRoute();

/* --- What the live top row decides: who wears the fill, who makes room, whether the strip is up -------
 *
 * Measured rather than declared: which bars stand in the top row, and which of them ends at the window's
 * right edge, are facts about the layout, and they change with the chat's home, a popped-out panel, the route,
 * an extension's own view (titleBar.ts). The reserve is an inline property on that bar because a class would
 * be patched away the next time its component re-rendered, and the value is the shared custom property, so the
 * number itself stays in styles.css beside the row it is taken out of. The fill is an attribute for the same
 * reason, and the stylesheet does the painting. */
const RESERVE = `padding-inline-end`;
let reserved: HTMLElement | undefined;
let scheduled = 0;

/* THE BARS, WATCHED FOR MOVING. A `ResizeObserver` over the bars themselves rather than a `MutationObserver`
 * over the document: a column opening, closing or being dragged wider resizes every bar beside it, so the bars
 * are the one thing that changes exactly when the answers here do — and they never change while a turn streams
 * text into the chat, which is the case a document observer would fire on all day. `observe()` reports once on
 * arrival, so only bars not yet watched are added: the set converges instead of re-measuring itself forever. */
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

/* One measurement per frame at most, and only after something that can have moved a bar: the window resizing,
 * a bar resizing (the observer above), the route changing, or a press/keystroke that ran a command. */
const schedule = (): void => {
    if (scheduled === 0) {
        scheduled = requestAnimationFrame(measure);
    }
};

/* --- The bar as a title bar ---------------------------------------------------------------------------- */

/* `mousedown`, not `pointerdown`: a pointer event's `detail` is 0 by specification, and `detail` is how many
 * clicks deep this press is — which is the whole of "double-click the title bar to maximise". The mouse event
 * is the one that carries it, and it is what Tauri's own drag regions listen on. */
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
    /* The app is waiting to hear this. A frameless window whose page draws no bar is one nobody can move or
     * close, so the app hands the platform's frame back if nothing announces one within a few seconds
     * (windows.rs `arm_frame_fallback`) — and this is the announcement that stops it. It goes out once the
     * document has LOADED, not now: `openDesktopLink` holds it, because a navigation started while the page is
     * still loading is what left every frame of this window three times too slow. */
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
        <!-- THE BAR OF LAST RESORT (titleBar.ts `STRIP`): the full width of the window, exactly as tall as the
             row it stands in for, and only while no bar stands in the top row — over the workspace's own bars it
             would cover their controls. The one thing on a login page that says "this is a window": the title
             fill with its shadow onto the artwork, and a surface that drags. -->
        <div v-if="bare" class="window-titlebar" aria-hidden="true"></div>
        <!-- `data-window-no-drag`: this strip is the one part of the title bar that is not draggable, because all
             of it is buttons and the gap between them is a hair. The row keeps a gutter to its left for that. -->
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
/* The strip paints from the same two properties the bars do (styles.css `--title-bar-fill`, `--title-bar-shadow`),
 * so the login page's bar and the workspace's row are one object in two places. It sits one step under the
 * buttons and above everything else, and it carries the row's bottom line so the line is there whether a bar
 * drew it or not. */
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

/* Over the row rather than in it: the bar underneath reserves the width (see the reserve above), and this sits
 * in the window's corner where every platform this app ships for keeps these three buttons.
 *
 * IT CARRIES THE ROW'S BOTTOM LINE ITSELF, which looks redundant — the bar under it draws the same border, in
 * the same colour, on the same pixel — and is not. A button's hover fill covers its whole box, so with the
 * strip standing the full height of the bar, hovering one painted OVER that pixel: a 40px gap in the line that
 * runs unbroken across the window (styles.css `.view-header`), and on the × a red block bleeding into it. With
 * the border here the fills stop one pixel short of it, and the line is drawn either way. */
.window-controls {
    position: fixed;
    inset-block-start: 0;
    inset-inline-end: 0;
    z-index: 40;
    display: flex;
    height: var(--bar-height);
    border-block-end: 1px solid var(--color-line);
}

/* A wide, full-height target rather than a round icon button, which is what makes the corner of the screen
 * hittable without aiming. A little narrower than the platform's own 46px: whichever bar these stand at the
 * end of gives up the width, and in the default layout that bar is a 22rem chat column — every pixel here is
 * one taken off the title of the conversation being read. Three of these is `--window-controls-buttons`. */
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

/* The one press that is not undoable, in the colour every platform gives it, and only under the pointer: a red
 * square sitting in the corner of every screen would be the loudest thing in the app at rest. */
.window-control-close:hover {
    background: var(--color-danger-600);
    color: var(--color-danger-0);
}

.window-control:focus-visible {
    outline: 1px solid var(--color-primary-500);
    outline-offset: -2px;
}
</style>

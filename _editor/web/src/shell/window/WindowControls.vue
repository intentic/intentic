<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { DESKTOP_WINDOW_EVENT, type DesktopWindowEvent, desktopFrameless, workDesktopWindow } from "../../app/environments/desktop";
import { BAR, edgeBar, titleBarGesture } from "./titleBar";

/* THE WINDOW'S OWN THREE BUTTONS, IN THE ROW THIS APP ALREADY DRAWS.
 *
 * The desktop app's window has no platform title bar (desktop-app windows.rs). What that strip carried was a
 * logo, a name and minimise/maximise/close — a full row of screen above a product whose own top row is
 * already a full-width bar, with the logo and the name each said twice over (the taskbar, the rail's sandbox
 * chip). So the row does both jobs now: the columns keep their controls, the window's three go at its right
 * end, and every empty stretch of it drags the window.
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
 * intercepts in Rust, including the drag, which is handed to the platform's own move loop from there. */

const frameless = desktopFrameless();
const maximized = ref(false);
const route = useRoute();

/* --- The room the buttons need, taken from whichever bar is under them --------------------------------
 *
 * Measured rather than declared: which bar ends at the window's right edge is a fact about the layout, and it
 * changes with the chat's home, a popped-out panel, the route, an extension's own view (titleBar.ts). The
 * reserve is an inline property on that bar because a class would be patched away the next time its component
 * re-rendered, and the value is the shared custom property, so the number itself stays in styles.css beside
 * the row it is taken out of. */
const RESERVE = `padding-inline-end`;
let reserved: HTMLElement | undefined;
let scheduled = 0;

const measure = (): void => {
    scheduled = 0;
    const bars = [...document.querySelectorAll<HTMLElement>(BAR)];
    // `clientWidth`, not `innerWidth`: a page with a scrollbar of its own would otherwise measure the window as
    // wider than the widest a bar in it can be, and reserve nothing.
    const edge = edgeBar(bars, (bar) => bar.getBoundingClientRect(), document.documentElement.clientWidth);
    if (edge === reserved) {
        return;
    }
    reserved?.style.removeProperty(RESERVE);
    edge?.style.setProperty(RESERVE, `var(--window-controls-width)`);
    reserved = edge;
};

/* One measurement per frame at most, and only after something that can have moved a bar: the window resizing,
 * the route changing, or a press/keystroke that ran a command. Deliberately NOT an observer over the document:
 * the shell mutates constantly while a turn streams, and none of that touches the top row. */
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
     * (windows.rs `arm_frame_fallback`) — and this is the announcement that stops it. */
    workDesktopWindow(`ready`);
});

onUnmounted(() => {
    if (!frameless) {
        return;
    }
    document.documentElement.removeAttribute(`data-frameless`);
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
});
</script>

<template>
    <!-- `data-window-no-drag`: this strip is the one part of the title bar that is not draggable, because all
         of it is buttons and the gap between them is a hair. The row keeps a gutter to its left for that.

         THE MARKS ARE DRAWN HERE rather than taken from the icon set. That set is the app's shared vocabulary
         for what a view MEANS; these three are the platform's own furniture, down to the offset squares that
         say "restore", and they exist at 10px and at no other size. This is also the only window in the
         product that has them: the app's launcher face is a card with a × of its own (desktop-app App.vue). -->
    <div v-if="frameless" class="window-controls" data-window-no-drag>
        <button type="button" class="window-control" aria-label="Minimise" @click="workDesktopWindow(`minimize`)">
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
        </button>
        <button type="button" class="window-control" :aria-label="maximized ? `Restore` : `Maximise`" @click="workDesktopWindow(`maximize`)">
            <svg v-if="maximized" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2.5 2.5h7v7h-7z" />
                <path d="M0.5 7.5v-7h7" />
            </svg>
            <svg v-else viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5h9v9h-9z" /></svg>
        </button>
        <button type="button" class="window-control window-control-close" aria-label="Close" @click="workDesktopWindow(`close`)">
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
        </button>
    </div>
</template>

<style scoped>
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

.window-control svg {
    width: 0.625rem;
    height: 0.625rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
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

import { nextTick, onBeforeUnmount, onMounted, type Ref, watch } from "vue";
import { commits, FLING, lockAxis, SETTLE, springReaches, springTiming, tick, travelsPerSecond, velocityTracker } from "@intentic/ui/motion";
import { EDGE_PX } from "../lib/edgeZone";
import { inNativeShell } from "../workbench/window/capacitor";

// THE WAY BACK, UNDER A THUMB. A phone's drill-down (an agent's chat, a Sandbox page) has its way back in the top-left
// corner, the one spot a thumb holding the phone cannot reach, and going back is what a phone does most: board to agent
// and back again is most of every mobile session (PostHog, 2026-10: 249 and 225 of the mobile navigations, and the back
// arrow the most pressed control). So the page's left edge is a handle: a finger drawn in from it takes the page with it,
// the place it came from showing beneath, and a release past a third of the screen, or a flick, goes back. Short of
// that it springs back where it was.
//
// Touch events rather than pointer events, because this gesture has to share a page with every scroller on it: a
// pointer is the browser's the moment its scroll starts, and `touch-action` would have to forbid horizontal scrolling
// under the whole page to keep it. A touchmove can still be refused in the first few pixels, before the browser's own
// scroll slop, which is where the axis is decided (motion/swipe.ts).

// Past this share of the screen a release goes back, before its speed is counted.
const COMMIT_SHARE = 0.35;
// A finger that sat still this long before moving is a long press: a selection being extended, never a swipe.
const LONG_PRESS_MS = 300;
// How far the place it goes back to travels in from as it arrives, as a share of the screen: the parallax of a stack.
const ARRIVE_SHARE = 0.14;
// A navigation that has not landed by now was refused (a guard, an unsaved draft): the page comes back.
const LANDING_MS = 900;

export interface EdgeBackHost {
    /** Where touches are heard: the shell's main region, so a sheet or menu teleported over it is never in the gesture. */
    readonly surface: Readonly<Ref<HTMLElement | undefined>>;
    /** What the finger moves: the page. */
    readonly page: Readonly<Ref<HTMLElement | undefined>>;
    /** What shows under it, lightening as the page leaves. */
    readonly scrim: Readonly<Ref<HTMLElement | undefined>>;
    /** The arrow that says where a release goes, filling at the line. */
    readonly chip: Readonly<Ref<HTMLElement | undefined>>;
    /** The way back from where the reader is, undefined where there is none (a tab's own screen). */
    readonly back: () => (() => unknown) | undefined;
    /** The route, as a key: a change is the navigation landing. */
    readonly route: () => string;
}

/**
 * Whether the browser already draws this gesture: Safari on an iPhone or iPad, outside a home-screen app and outside the
 * native shell (a Capacitor web view has no back swipe). A second one on top would answer the same finger twice.
 */
export const nativeSwipeBack = (userAgent: string, touchMac: boolean, standalone: boolean, nativeShell: boolean): boolean =>
    (/iP(hone|od|ad)/.test(userAgent) || touchMac) && !standalone && !nativeShell;

const browserSwipesBack = (): boolean =>
    nativeSwipeBack(
        navigator.userAgent,
        navigator.platform === `MacIntel` && navigator.maxTouchPoints > 1,
        (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia(`(display-mode: standalone)`).matches,
        inNativeShell(),
    );

const touchOf = (list: TouchList, id: number): Touch | undefined => {
    for (let i = 0; i < list.length; i += 1) {
        const touch = list.item(i);
        if (touch?.identifier === id) {
            return touch;
        }
    }
    return undefined;
};

export function useEdgeBack(host: EdgeBackHost): void {
    const track = velocityTracker();
    let finger: { readonly id: number; readonly x: number; readonly y: number; readonly t: number } | undefined;
    let axis: `x` | `y` | undefined;
    let go: (() => unknown) | undefined;
    let width = 0;
    let target = 0;
    let drawn = 0;
    let frame = 0;
    let armed = false;
    // From a release that goes back until the place it went back to has arrived: no new gesture starts in between.
    let leaving = false;
    let landing: ReturnType<typeof setTimeout> | undefined;
    let running: Animation | undefined;
    let native = false;

    const layers = (): HTMLElement[] => [host.page.value, host.scrim.value, host.chip.value].filter((el): el is HTMLElement => el !== undefined);

    // The page's shadow and the layers' promotion are set once, as the drag starts: every frame after is a transform or
    // an opacity on a layer of its own, which the compositor moves without a paint.
    const lift = (on: boolean): void => {
        const page = host.page.value;
        const well = host.scrim.value?.parentElement;
        if (page !== undefined) {
            page.style.boxShadow = on ? `-16px 0 32px -12px rgb(0 0 0 / 0.45)` : ``;
        }
        if (well instanceof HTMLElement) {
            well.style.visibility = on ? `visible` : ``;
        }
        for (const el of layers()) {
            el.style.willChange = on ? `transform, opacity` : ``;
        }
    };

    const paint = (x: number): void => {
        drawn = x;
        const page = host.page.value;
        if (page !== undefined) {
            page.style.transform = x === 0 ? `` : `translate3d(${x}px, 0, 0)`;
        }
        const travelled = width === 0 ? 0 : Math.min(1, x / width);
        const share = width === 0 ? 0 : Math.min(1, x / (width * COMMIT_SHARE));
        if (host.scrim.value !== undefined) {
            host.scrim.value.style.opacity = `${1 - travelled}`;
        }
        if (host.chip.value !== undefined) {
            // In from beyond the edge as the page uncovers it, full size at the line.
            host.chip.value.style.opacity = `${share}`;
            host.chip.value.style.transform = `translate3d(${-48 + 48 * share}px, 0, 0) scale(${0.6 + 0.4 * share})`;
        }
        const now = share >= 1;
        if (now !== armed) {
            armed = now;
            host.chip.value?.toggleAttribute(`data-armed`, now);
            if (now) {
                tick();
            }
        }
    };

    const schedule = (): void => {
        frame ||= requestAnimationFrame(() => {
            frame = 0;
            paint(target);
        });
    };

    // The page, scrim and chip from where they stand to the page at `to`, on one spring carrying the release's speed.
    const glide = (to: number, velocity: number, spring: typeof SETTLE): Animation | undefined => {
        const page = host.page.value;
        const from = drawn;
        const before = {
            scrim: host.scrim.value?.style.opacity ?? `1`,
            chip: host.chip.value?.style.opacity ?? `0`,
            chipAt: host.chip.value?.style.transform ?? ``,
        };
        const timing = springTiming(to - from, velocity * Math.sign(to - from), spring);
        paint(to);
        if (page === undefined || timing.duration === 0 || typeof page.animate !== `function`) {
            return undefined;
        }
        running = page.animate([{ transform: `translate3d(${from}px, 0, 0)` }, { transform: `translate3d(${to}px, 0, 0)` }], timing);
        host.scrim.value?.animate([{ opacity: before.scrim }, { opacity: host.scrim.value.style.opacity }], timing);
        host.chip.value?.animate(
            [
                { opacity: before.chip, transform: before.chipAt },
                { opacity: host.chip.value.style.opacity, transform: host.chip.value.style.transform },
            ],
            timing,
        );
        return running;
    };

    // Every spring in flight on the page and its layers, dropped where it stands: a chip still fading in from the last
    // release would otherwise be drawn over the next drag, or through the page arriving.
    const stop = (): void => {
        running = undefined;
        for (const el of layers()) {
            for (const run of el.getAnimations?.() ?? []) {
                run.cancel();
            }
        }
    };

    const rest = (): void => {
        running = undefined;
        lift(false);
        host.chip.value?.removeAttribute(`data-armed`);
        armed = false;
    };

    const settle = (velocity: number): void => {
        const run = glide(0, velocity, SETTLE);
        if (run === undefined) {
            rest();
            return;
        }
        run.finished.then(
            () => {
                if (running === run && finger === undefined) {
                    rest();
                }
            },
            () => {},
        );
    };

    // The place it went back to has rendered: it slides in from a little to the left as the well under it fades, the
    // stack's parallax, on a spring with nothing to carry.
    const arrive = async (): Promise<void> => {
        if (!leaving) {
            return;
        }
        leaving = false;
        if (landing !== undefined) {
            clearTimeout(landing);
            landing = undefined;
        }
        await nextTick();
        stop();
        const page = host.page.value;
        const from = -width * ARRIVE_SHARE;
        paint(0);
        const timing = springTiming(from, 0, SETTLE);
        if (page === undefined || timing.duration === 0 || typeof page.animate !== `function`) {
            rest();
            return;
        }
        // The chip and the scrim leave with the old page; the new one arrives over a plain well.
        if (host.chip.value !== undefined) {
            host.chip.value.style.opacity = `0`;
        }
        page.style.boxShadow = ``;
        const run = page.animate(
            [
                { transform: `translate3d(${from}px, 0, 0)`, opacity: 0 },
                { transform: `translate3d(0, 0, 0)`, opacity: 1 },
            ],
            timing,
        );
        running = run;
        run.finished.then(
            () => {
                if (running === run) {
                    rest();
                }
            },
            () => {},
        );
    };

    const commit = (velocity: number): void => {
        const way = go;
        leaving = true;
        // Past the edge by the shadow's reach, so none of it is left on screen.
        const exit = width + 32;
        const from = drawn;
        const run = glide(exit, velocity, FLING);
        const out = run === undefined ? 0 : springReaches(FLING, travelsPerSecond(velocity, exit - from), (width - from) / (exit - from));
        // Gone from sight is when the navigation goes: its render then happens under a page already off screen.
        setTimeout(() => {
            void way?.();
            landing = setTimeout(() => {
                // Refused: nothing navigated, so the page comes back from where it went.
                landing = undefined;
                if (leaving) {
                    leaving = false;
                    stop();
                    drawn = exit;
                    settle(0);
                }
            }, LANDING_MS);
        }, out * 1000);
    };

    const onStart = (event: TouchEvent): void => {
        if (finger !== undefined) {
            // A second finger is a pinch, not a swipe.
            if (event.touches.length > 1) {
                release(undefined, false);
            }
            return;
        }
        const touch = event.changedTouches[0];
        if (leaving || native || event.touches.length !== 1 || touch === undefined || touch.clientX > EDGE_PX) {
            return;
        }
        go = host.back();
        if (go === undefined) {
            return;
        }
        finger = { id: touch.identifier, x: touch.clientX, y: touch.clientY, t: event.timeStamp };
        axis = undefined;
        width = host.surface.value?.clientWidth ?? window.innerWidth;
        track.reset();
        track.push(event.timeStamp, touch.clientX);
    };

    const onMove = (event: TouchEvent): void => {
        if (finger === undefined) {
            return;
        }
        const touch = touchOf(event.changedTouches, finger.id);
        if (touch === undefined) {
            return;
        }
        const dx = touch.clientX - finger.x;
        if (axis === undefined) {
            axis = lockAxis(dx, touch.clientY - finger.y);
            if (axis === undefined) {
                return;
            }
            // Down is the page's scroll, left is not back, a held press is a selection, and a move the browser already
            // scrolls with is the browser's.
            if (axis === `y` || dx < 0 || event.timeStamp - finger.t > LONG_PRESS_MS || !event.cancelable) {
                finger = undefined;
                axis = undefined;
                return;
            }
            stop();
            lift(true);
        }
        event.preventDefault();
        track.push(event.timeStamp, touch.clientX);
        target = Math.max(0, dx);
        schedule();
    };

    const release = (event: TouchEvent | undefined, ended: boolean): void => {
        const dragging = axis === `x`;
        finger = undefined;
        axis = undefined;
        if (frame !== 0) {
            cancelAnimationFrame(frame);
            frame = 0;
        }
        if (!dragging) {
            return;
        }
        paint(target);
        const velocity = event === undefined ? 0 : track.velocity(event.timeStamp);
        // A cancel is the system taking the touch (Android's own back edge, a notification shade): never a commit.
        if (ended && commits({ travel: drawn, velocity, extent: width }, COMMIT_SHARE)) {
            commit(velocity);
        } else {
            settle(velocity);
        }
    };

    const onEnd = (event: TouchEvent): void => {
        if (finger !== undefined && touchOf(event.changedTouches, finger.id) !== undefined) {
            release(event, event.type === `touchend`);
        }
    };

    // The navigation landing, whichever way it came: ours arrives; anyone else's mid-drag ends the drag where it stands.
    watch(host.route, () => {
        if (leaving) {
            void arrive();
            return;
        }
        if (finger !== undefined) {
            finger = undefined;
            axis = undefined;
            stop();
            paint(0);
            rest();
        }
    });

    let bound: HTMLElement | undefined;
    onMounted(() => {
        native = browserSwipesBack();
        bound = host.surface.value;
        bound?.addEventListener(`touchstart`, onStart, { passive: true });
        // Not passive: refusing the first moves is what keeps the page from scrolling under a swipe.
        bound?.addEventListener(`touchmove`, onMove, { passive: false });
        bound?.addEventListener(`touchend`, onEnd, { passive: true });
        bound?.addEventListener(`touchcancel`, onEnd, { passive: true });
    });
    onBeforeUnmount(() => {
        bound?.removeEventListener(`touchstart`, onStart);
        bound?.removeEventListener(`touchmove`, onMove);
        bound?.removeEventListener(`touchend`, onEnd);
        bound?.removeEventListener(`touchcancel`, onEnd);
        if (frame !== 0) {
            cancelAnimationFrame(frame);
        }
        if (landing !== undefined) {
            clearTimeout(landing);
        }
        stop();
    });
}

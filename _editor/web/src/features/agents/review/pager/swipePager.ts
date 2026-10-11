import { onBeforeUnmount, onMounted, type Ref, watch } from "vue";
import { commits, lockAxis, rubberBand, SETTLE, springTiming, velocityTracker } from "@intentic/ui/motion";
import { EDGE_PX } from "../../../../shell/edgeBack";
import { swipeBelongsElsewhere } from "./swipeYields";

// PAGES SIDE BY SIDE, UNDER A THUMB. A phone's agent screen is two pages, the chat and its changes, and the switch
// between them used to be a row of tabs that cost the transcript a line of its height. Now the pages lie side by side
// and a finger drawn across either one takes both with it, the neighbour sliding in as the first leaves; a release past
// COMMIT_SHARE of the width, or a flick, lands on the neighbour, and short of that springs back. A press elsewhere (the
// header's switch) moves them the same way, so the reader learns where the other page lives from the motion itself.
//
// Touch events, for the reason shell/edgeBack.ts gives: the gesture shares the page with every scroller on it, and the
// axis has to be decided before the browser's own scroll takes the finger. The left edge stays the way back.
//
// Each page is moved on its own (absolutely placed, translated by its distance from the one in view), never a strip
// holding both: at rest the page in view carries no transform at all, so nothing fixed-position inside it is pinned to
// a moving box, and a page off to the side is hidden rather than painted.

// Past this share of the width a release turns the page, before its speed is counted.
const COMMIT_SHARE = 0.4;
// A finger that sat still this long before moving is a long press: a selection, never a swipe.
const LONG_PRESS_MS = 300;
// A release this recent turns the tap the browser may still fire into nothing: the finger was dragging, not pressing.
const CLICK_GUARD_MS = 400;

export interface SwipePagerHost {
    /** The window onto the pages: touches are heard here, and its width is one page's travel. */
    readonly surface: Readonly<Ref<HTMLElement | null | undefined>>;
    /** The pages, in order, each filling the surface. Undefined entries are pages not drawn yet and are skipped. */
    readonly pages: () => readonly (HTMLElement | undefined)[];
    /** What says which page shows, moved along with the pages: one page's travel is its own width. */
    readonly follower?: () => HTMLElement | null | undefined;
    /** The page the pager rests on. A change from outside slides there. */
    readonly index: () => number;
    /** A swipe landed on this page. */
    readonly select: (index: number) => void;
    /** A finger came down where it could page: the moment to have the neighbour ready. */
    readonly wake?: () => void;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

// Keyframes always name a translation; the resting style drops it at zero (see the header).
const shift = (pages: number): string => `translate3d(${pages * 100}%, 0, 0)`;
const restingShift = (pages: number): string => (pages === 0 ? `` : shift(pages));

const touchOf = (list: TouchList, id: number): Touch | undefined => {
    for (let i = 0; i < list.length; i += 1) {
        const touch = list.item(i);
        if (touch?.identifier === id) {
            return touch;
        }
    }
    return undefined;
};

// How far across an element stands right now, in px, animations included: where a finger catches a page in flight.
const shownOffset = (el: HTMLElement): number | undefined => {
    const transform = getComputedStyle(el).transform;
    if (transform === `` || transform === `none`) {
        return 0;
    }
    return typeof DOMMatrixReadOnly === `function` ? new DOMMatrixReadOnly(transform).m41 : undefined;
};

export function useSwipePager(host: SwipePagerHost): void {
    const track = velocityTracker();
    let finger: { readonly id: number; readonly x: number; readonly y: number; readonly t: number; readonly target: EventTarget | null } | undefined;
    let axis: `x` | `y` | undefined;
    let width = 0;
    // Where the pages stood when the finger took them, in pages (fractional when caught mid-glide).
    let base = 0;
    let target = 0;
    let drawn = 0;
    let frame = 0;
    // The glide in flight (its first page's animation) and the page it is headed for.
    let running: Animation | undefined;
    let aim = 0;
    let swallowClickUntil = 0;

    const pages = (): HTMLElement[] => host.pages().filter((page): page is HTMLElement => page !== undefined);
    const last = (): number => Math.max(0, pages().length - 1);
    const follower = (): HTMLElement | undefined => host.follower?.() ?? undefined;
    const measure = (): number => host.surface.value?.clientWidth ?? 0;

    // Every page at its distance from `position`, and the follower under it. At rest, a page out of view is hidden and
    // nothing keeps a compositor layer; mid-move, every page is drawn, since any of them may be crossing the window.
    const paint = (position: number, resting: boolean): void => {
        drawn = position;
        pages().forEach((page, i) => {
            const offset = i - position;
            page.style.transform = restingShift(offset);
            page.style.visibility = resting && Math.abs(offset) >= 1 ? `hidden` : ``;
            page.style.willChange = resting ? `` : `transform`;
        });
        const mark = follower();
        if (mark !== undefined) {
            mark.style.transform = restingShift(clamp(position, 0, last()));
            mark.style.willChange = resting ? `` : `transform`;
        }
    };

    const schedule = (): void => {
        frame ||= requestAnimationFrame(() => {
            frame = 0;
            paint(target, false);
        });
    };

    // Whatever is gliding, stopped where it stands rather than where it was going.
    const stop = (): void => {
        if (running === undefined) {
            return;
        }
        running = undefined;
        const first = pages()[0];
        const offset = first === undefined ? undefined : shownOffset(first);
        const els = [...pages(), follower()].filter((el): el is HTMLElement => el !== undefined);
        for (const el of els) {
            for (const run of el.getAnimations?.() ?? []) {
                run.cancel();
            }
        }
        const across = measure();
        paint(offset === undefined || across === 0 ? drawn : -offset / across, false);
    };

    // From where the pages are drawn to page `to`, on one spring carrying `velocity` (px/ms, positive toward `to`).
    const glide = (to: number, velocity: number): void => {
        const from = drawn;
        width = measure();
        aim = to;
        const timing = springTiming((to - from) * width, velocity, SETTLE);
        const els = pages();
        const mark = follower();
        paint(to, false);
        if (timing.duration === 0 || els[0] === undefined || typeof els[0].animate !== `function`) {
            paint(to, true);
            return;
        }
        const runs = els.map((page, i) => page.animate([{ transform: shift(i - from) }, { transform: shift(i - to) }], timing));
        const edge = last();
        mark?.animate([{ transform: shift(clamp(from, 0, edge)) }, { transform: shift(clamp(to, 0, edge)) }], timing);
        const run = runs[0];
        running = run;
        run?.finished.then(
            () => {
                if (running === run) {
                    running = undefined;
                    paint(to, true);
                }
            },
            () => {},
        );
    };

    const stretch = (position: number): number => {
        const end = last();
        if (position < 0) {
            return -rubberBand(-position * width, width) / width;
        }
        if (position > end) {
            return end + rubberBand((position - end) * width, width) / width;
        }
        return position;
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
        // The left edge is the way back (shell/edgeBack.ts, or the browser's own): never a page turn.
        if (touch === undefined || event.touches.length !== 1 || pages().length < 2 || touch.clientX <= EDGE_PX) {
            return;
        }
        finger = { id: touch.identifier, x: touch.clientX, y: touch.clientY, t: event.timeStamp, target: event.target };
        axis = undefined;
        track.reset();
        track.push(event.timeStamp, touch.clientX);
        host.wake?.();
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
            const surface = host.surface.value ?? undefined;
            // Down is the page's scroll, a held press is a selection, a move the browser already scrolls with is the
            // browser's, and a sideways move inside something that moves sideways is that thing's.
            if (
                axis === `y` ||
                surface === undefined ||
                event.timeStamp - finger.t > LONG_PRESS_MS ||
                !event.cancelable ||
                swipeBelongsElsewhere(finger.target, surface)
            ) {
                finger = undefined;
                axis = undefined;
                return;
            }
            width = surface.clientWidth;
            stop();
            base = drawn;
        }
        event.preventDefault();
        track.push(event.timeStamp, touch.clientX);
        target = width === 0 ? base : stretch(base - dx / width);
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
        swallowClickUntil = performance.now() + CLICK_GUARD_MS;
        paint(target, false);
        // The finger's speed, px/ms: rightward is back toward the first page.
        const velocity = event === undefined ? 0 : track.velocity(event.timeStamp);
        const home = clamp(Math.round(base), 0, last());
        const moved = drawn - home;
        const toward = moved > 0 ? home + 1 : moved < 0 ? home - 1 : home;
        let to = home;
        // A cancel is the system taking the touch (a notification shade, Android's back edge): never a page turn.
        if (ended && toward !== home && toward >= 0 && toward <= last()) {
            const way = Math.sign(toward - home);
            if (commits({ travel: Math.abs(moved) * width, velocity: -velocity * way, extent: width }, COMMIT_SHARE)) {
                to = toward;
            }
        }
        glide(to, to === drawn ? 0 : -velocity * Math.sign(to - drawn));
        if (to !== host.index()) {
            host.select(to);
        }
    };

    const onEnd = (event: TouchEvent): void => {
        if (finger !== undefined && touchOf(event.changedTouches, finger.id) !== undefined) {
            release(event, event.type === `touchend`);
        }
    };

    const onClick = (event: MouseEvent): void => {
        if (performance.now() < swallowClickUntil) {
            event.preventDefault();
            event.stopPropagation();
        }
        swallowClickUntil = 0;
    };

    // The page changed, whoever changed it: a press on the switch glides there; a swipe's own release already is.
    watch(host.index, (index, previous) => {
        // Whatever had the keyboard on the page now out of view lets go of it, so no keyboard stays up over the other page.
        const active = document.activeElement;
        if (active instanceof HTMLElement && pages()[previous]?.contains(active) === true) {
            active.blur();
        }
        if (axis === `x` || (running !== undefined && aim === index)) {
            return;
        }
        stop();
        glide(clamp(index, 0, last()), 0);
    });

    // A page arriving or leaving (the changes page appears once there is a branch): everything re-placed at rest.
    watch(
        () => pages().length,
        () => {
            if (axis === `x`) {
                return;
            }
            stop();
            paint(clamp(host.index(), 0, last()), true);
        },
        { flush: `post` },
    );

    let bound: HTMLElement | undefined;
    onMounted(() => {
        paint(clamp(host.index(), 0, last()), true);
        bound = host.surface.value ?? undefined;
        bound?.addEventListener(`touchstart`, onStart, { passive: true });
        // Not passive: refusing the first moves is what keeps the transcript from scrolling under a swipe.
        bound?.addEventListener(`touchmove`, onMove, { passive: false });
        bound?.addEventListener(`touchend`, onEnd, { passive: true });
        bound?.addEventListener(`touchcancel`, onEnd, { passive: true });
        bound?.addEventListener(`click`, onClick, { capture: true });
    });
    onBeforeUnmount(() => {
        bound?.removeEventListener(`touchstart`, onStart);
        bound?.removeEventListener(`touchmove`, onMove);
        bound?.removeEventListener(`touchend`, onEnd);
        bound?.removeEventListener(`touchcancel`, onEnd);
        bound?.removeEventListener(`click`, onClick, { capture: true });
        if (frame !== 0) {
            cancelAnimationFrame(frame);
        }
        running = undefined;
    });
}

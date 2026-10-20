import { type InjectionKey, nextTick, onMounted, onUnmounted, type Ref, ref } from "vue";

// Stays pinned to the bottom unless the user scrolls up away from it; follow() re-pins on any change, keyed on scroll
// state rather than a panel-owned flag. Any upward scroll by the reader counts as leaving, however small: a soft wheel
// notch that stayed near the bottom and still counted as parked was dragged back down by the next layout change (a row
// realizing as it scrolls into view, a streamed token), which reads as the view flickering back. An upward move the
// layout caused (content shrinking under the reader clamps scrollTop) is not the reader leaving.
//
// Nothing on screen moves except by the reader's own hand. Two kinds of growth look the same to an observer: a message
// arriving, which a parked reader follows, and the reader opening a fold, which they are about to read. So the fold's
// press says which it was (hold, below) instead of the observer guessing; and a finger on the screen is the reader
// scrolling, which no growth may pull back down.

// How close to the bottom counts as parked again when the reader scrolls back down; absorbs sub-pixel rounding and
// saves them landing on the exact last pixel.
const THRESHOLD = 80;

// Keeps the control the reader pressed where it stands while its fold opens or shuts (hold, below). Provided by the
// pane that owns the scroller (paneScroll.ts); a transcript shown without one (a published conversation) just runs the
// change.
// The pressed control comes as a click's `currentTarget` or a template ref, so anything that is not an element is taken
// as nothing to hold.
export type TranscriptHold = (element: EventTarget | null | undefined, change: () => void) => void;
export const TRANSCRIPT_HOLD: InjectionKey<TranscriptHold> = Symbol(`transcriptHold`);

// A finger on the scroller is the reader scrolling. Moving down the screen it scrolls the content up: the reader
// leaving, said before the scroll it causes, as a wheel says it (useStickToBottom's onWheel). Down at all, it holds off
// pinning: re-pinning mid-drag yanks the content out from under the finger, and while a stream reshapes the content
// between every scroll event the drag's own scrolls cannot be told from clamping. `lifted` runs as the last finger goes,
// to catch up on growth held off meanwhile; a fling carrying on upward is a scroll the reader's own move accounted for.
// Answers whether a finger is down.
const watchFinger = (element: HTMLElement, signal: AbortSignal, leave: () => void, lifted: () => void): (() => boolean) => {
    // Where the finger was at the last touch event; undefined with none down.
    let y: number | undefined;
    const options = { passive: true, signal };
    const lift = (event: TouchEvent): void => {
        if (event.touches.length === 0) {
            y = undefined;
            lifted();
        }
    };
    element.addEventListener(`touchstart`, (event) => (y = event.touches[0]?.clientY), options);
    element.addEventListener(
        `touchmove`,
        (event) => {
            const next = event.touches[0]?.clientY;
            if (next !== undefined && y !== undefined && next > y && element.scrollTop > 0) {
                leave();
            }
            y = next ?? y;
        },
        options,
    );
    element.addEventListener(`touchend`, lift, options);
    element.addEventListener(`touchcancel`, lift, options);
    return () => y !== undefined;
};

// Runs a fold's `change` with `target`, the control the reader pressed, kept on the pixels it stands on: measured
// before, and the scroller moved by however far it went once Vue has drawn the change (on a later microtask, never in
// the press's own task). Opening adds below the press, so the material starts where the reader is looking instead of
// the scroller re-pinning to its end; they are reading it now, so `leave` un-parks them first. `settled` gets the
// scroller once the change is drawn. Shutting a fold at the bottom shrinks the content under the reader and the
// browser's clamp is all that moves; a reader left at the bottom then is parked again, since no scroll event could
// re-park them there.
const keepInPlace = (
    element: HTMLElement | null,
    target: EventTarget | null | undefined,
    change: () => void,
    leave: () => void,
    settled: (element: HTMLElement) => void,
): void => {
    if (element === null || !(target instanceof Element)) {
        change();
        return;
    }
    const before = target.getBoundingClientRect().top;
    leave();
    change();
    void nextTick(() => {
        if (target.isConnected) {
            element.scrollTop += target.getBoundingClientRect().top - before;
        }
        settled(element);
    });
};

// Watches two boxes: the content wrapper (grows with streamed tokens, images, reflow) and the scroller's content box
// (shrinks when the panel, composer, or keyboard resizes it). Neither implies the other.
const observeBoxes = (element: HTMLElement | null, wrapper: HTMLElement | null, follow: () => void): ResizeObserver | undefined => {
    if (element === null || wrapper === null) {
        return undefined;
    }
    const observer = new ResizeObserver(follow);
    observer.observe(wrapper);
    observer.observe(element, { box: `content-box` });
    return observer;
};

// Both refs are template refs: null is what Vue writes into one once its element is gone, and every read here can
// land after that (a resize observation, a post-flush follow, an unmounting pane).
export const useStickToBottom = (
    scroller: Ref<HTMLElement | null>,
    content: Ref<HTMLElement | null>,
): { pin: () => void; follow: () => void; hold: TranscriptHold; parked: Readonly<Ref<boolean>> } => {
    // Closure state, not refs: reads happen inside DOM callbacks where reactivity buys nothing.
    let pinned = true;
    // The same, for a reader outside the DOM callbacks (the row window, paneWindow.ts, which may take rows above down
    // only while the reader is at the newest). Written on every change of `pinned`; a ref set to the value it holds
    // triggers nothing, so a scroll that leaves the state alone costs no effect.
    const parked = ref(true);
    const park = (value: boolean): void => {
        pinned = value;
        parked.value = value;
    };
    let lastTop = 0;
    // Geometry at the last scroll measure; an upward move while either changed is the browser clamping, not the reader.
    let lastHeight = 0;
    let lastClient = 0;
    // Whether a finger is down on the scroller, from mount.
    let touching = (): boolean => false;
    let observer: ResizeObserver | undefined;
    // Takes the scroller's listeners off; the template ref is already cleared by unmount.
    let listening: AbortController | undefined;

    const measure = (element: HTMLElement): void => {
        lastTop = element.scrollTop;
        lastHeight = element.scrollHeight;
        lastClient = element.clientHeight;
    };

    const pin = (): void => {
        park(true);
        const element = scroller.value;
        if (element === null) {
            return;
        }
        element.scrollTop = element.scrollHeight;
        // Read back the clamped value; the next scroll event is measured against it.
        measure(element);
    };

    // Re-pins if the reader hasn't left the bottom. Called by the resize observers and by the panel's
    // transcript-changed watch, since a resize observation can be coalesced or deferred past the growth that caused it.
    // Never under a finger (watchFinger says why).
    const follow = (): void => {
        if (pinned && !touching()) {
            pin();
        }
    };

    const onScroll = (): void => {
        const element = scroller.value;
        if (element === null) {
            return;
        }
        const top = element.scrollTop;
        const up = top < lastTop;
        const reshaped = element.scrollHeight !== lastHeight || element.clientHeight !== lastClient;
        measure(element);
        if (up) {
            if (!reshaped) {
                park(false);
            }
            return;
        }
        if (element.scrollHeight - top - element.clientHeight <= THRESHOLD) {
            park(true);
        }
    };

    // Wheel intent lands before the scroll it causes, and holds even when a reflow in the same frame reshapes the
    // content (which the scroll rule above then cannot tell from clamping).
    const onWheel = (event: WheelEvent): void => {
        if (event.deltaY < 0 && (scroller.value?.scrollTop ?? 0) > 0) {
            park(false);
        }
    };

    // A fold the reader pressed (keepInPlace says what holds still, and why the reader is parked after).
    const hold: TranscriptHold = (target, change) =>
        keepInPlace(scroller.value, target, change, () => park(false), (element) => {
            measure(element);
            park(element.scrollHeight - element.scrollTop - element.clientHeight <= 1);
        });

    onMounted(() => {
        const element = scroller.value;
        if (element === null) {
            return;
        }
        measure(element);
        listening = new AbortController();
        const options = { passive: true, signal: listening.signal };
        element.addEventListener(`scroll`, onScroll, options);
        element.addEventListener(`wheel`, onWheel, options);
        touching = watchFinger(element, listening.signal, () => park(false), follow);
        observer = observeBoxes(element, content.value, follow);
    });

    onUnmounted(() => {
        observer?.disconnect();
        observer = undefined;
        listening?.abort();
        listening = undefined;
    });

    return { pin, follow, hold, parked };
};

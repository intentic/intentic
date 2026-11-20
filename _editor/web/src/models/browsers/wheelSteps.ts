// Scrolling a live browser the way a local one scrolls: every wheel and trackpad event the person makes reaches the
// page, at the size it was, with nothing left over. A trackpad sends dozens of events a second, each a few pixels or a
// fraction of one; a mouse wheel sends notches of about a hundred. Rounding each event to a whole notch (what the X
// display did) scrolled a trackpad nothing and made a wheel jump, so deltas travel as fractional picture pixels, summed
// over one animation frame so a 120 Hz trackpad costs one message a frame, and whatever a message cannot carry waits
// for the next one rather than being lost.

// WheelEvent.deltaMode: pixels, lines (Firefox's mouse wheel) or pages.
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

// A line, in CSS pixels: Chromium's own step for one line of scrolling, so a Firefox wheel's three lines scroll what
// Chromium's own notch would there.
export const LINE_PX = 40;

// The smallest step a scroll message carries, in picture pixels: hundredths, which keeps a message short while every
// remainder below it is carried into the next.
const STEP_GRAIN = 100;

export interface WheelPixels {
    readonly dx: number;
    readonly dy: number;
}

/** A wheel event's deltas in CSS pixels, whatever unit it came in; `pageHeight` is what one page scrolls. */
export const wheelPixels = (event: Pick<WheelEvent, `deltaX` | `deltaY` | `deltaMode`>, pageHeight: number): WheelPixels => {
    const unit = event.deltaMode === DOM_DELTA_LINE ? LINE_PX : event.deltaMode === DOM_DELTA_PAGE ? pageHeight : 1;
    return { dx: event.deltaX * unit, dy: event.deltaY * unit };
};

/** Held modifiers on a scroll: Ctrl turns a wheel into zoom, Shift turns it sideways, on the page as locally. */
export interface ScrollModifiers {
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly alt?: boolean;
}

/** One frame's worth of scrolling, at the pointer, in picture pixels. */
export interface ScrollStep extends ScrollModifiers {
    readonly x: number;
    readonly y: number;
    readonly dx: number;
    readonly dy: number;
}

export interface WheelCoalescer {
    // A step to add to the frame's; the point is the latest one's, the deltas the sum.
    readonly add: (step: ScrollStep) => void;
    // Sends what the frame holds now, as a frame would.
    readonly flush: () => void;
    // Forgets the frame waiting to be sent and every remainder: the view went away.
    readonly cancel: () => void;
}

const sameModifiers = (left: ScrollModifiers, right: ScrollModifiers): boolean =>
    (left.ctrl === true) === (right.ctrl === true) &&
    (left.shift === true) === (right.shift === true) &&
    (left.alt === true) === (right.alt === true);

// Below this a sum's distance from a whole hundredth is floating-point noise, not a remainder (0.008 + 0.002 is
// 0.009999…), and cutting it toward zero would hold a whole step back.
const NOISE = 1e-9;

// A delta cut to the grain, toward zero, and the part of it the cut left behind.
const grained = (value: number): readonly [sent: number, left: number] => {
    const sent = Math.trunc(value * STEP_GRAIN + Math.sign(value) * NOISE) / STEP_GRAIN;
    return [sent, value - sent];
};

/**
 * Sums scroll steps over one animation frame and emits one message per frame. A change of modifiers sends what the
 * frame held first, since a zoom and a scroll must not be summed into one. `frame` schedules the flush (the browser's
 * requestAnimationFrame unless a test hands its own).
 */
export const wheelCoalescer = (
    emit: (step: ScrollStep) => void,
    frame: (flush: () => void) => () => void = (flush) => {
        const id = requestAnimationFrame(flush);
        return () => cancelAnimationFrame(id);
    },
): WheelCoalescer => {
    let pending: ScrollStep | undefined;
    let unschedule: (() => void) | undefined;
    // What earlier frames could not carry, in picture pixels: under a hundredth, added to the next frame's.
    let carryX = 0;
    let carryY = 0;

    const flush = (): void => {
        unschedule?.();
        unschedule = undefined;
        const step = pending;
        pending = undefined;
        if (step === undefined) {
            return;
        }
        const [dx, leftX] = grained(step.dx + carryX);
        const [dy, leftY] = grained(step.dy + carryY);
        carryX = leftX;
        carryY = leftY;
        if (dx === 0 && dy === 0) {
            return;
        }
        emit({ ...step, dx, dy });
    };

    return {
        add: (step) => {
            if (pending !== undefined && !sameModifiers(pending, step)) {
                flush();
            }
            pending = pending === undefined ? step : { ...step, dx: pending.dx + step.dx, dy: pending.dy + step.dy };
            unschedule ??= frame(flush);
        },
        flush,
        cancel: () => {
            unschedule?.();
            unschedule = undefined;
            pending = undefined;
            carryX = 0;
            carryY = 0;
        },
    };
};

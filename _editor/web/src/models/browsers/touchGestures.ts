// A live browser under a finger, on a phone or a tablet: tap clicks, a drag is a left-button drag (a text selection, a
// slider), a long press is a right click, two fingers scroll the page, and a pinch magnifies the view here (viewZoom.ts)
// without changing the page. Two fingers on a magnified view move the view first and scroll the page once the view is
// at its edge, so the content always follows the fingers.
//
// Trackpad mode makes the screen a laptop's trackpad instead: one finger moves a cursor from where it is, farther the
// faster it moves; a tap clicks where the cursor is, a two-finger tap right-clicks there, and press-and-hold then move
// drags. Two fingers and a pinch work as above.
//
// Only touch reaches here; a mouse and a pen keep the stage's own mouse handlers. The gestures are classified here and
// spoken through hooks in client pixels, so this module knows no socket and no picture.

// How far a finger may wander and still be a tap, in CSS pixels.
export const TAP_SLOP = 10;
// How long a still finger is a long press.
export const LONG_PRESS_MS = 550;
// A second tap this soon and this close clicks where the first did, so a double tap double-clicks though the finger
// lands a little off: GTK's and Qt's double-click time.
export const MULTI_TAP_MS = 400;
const MULTI_TAP_PX = 24;
// Trackpad mode: two fingers lifted this soon after the second landed, without moving, right-click.
const TWO_TAP_MS = 300;
// Trackpad mode's acceleration: the cursor moves (1 + ACCEL × speed) times as far as the finger, speed in CSS px per ms,
// at most MAX_GAIN times; slow moves are precise and fast ones cross the picture.
const ACCEL = 0.8;
const MAX_GAIN = 3;

// DOM button numbers, and what `buttons` holds while each is down.
const LEFT = 0;
const RIGHT = 2;
const LEFT_HELD = 1;

export interface Point {
    readonly x: number;
    readonly y: number;
}

// The fields of a pointer event this reads.
export type TouchPoint = Pick<PointerEvent, `pointerId` | `clientX` | `clientY` | `timeStamp`>;

export interface TouchHooks {
    // A pointer event at a client point: `button` is the one that changed, `buttons` what is held after it.
    readonly pointer: (action: `move` | `down` | `up`, at: Point, button: number, buttons: number, clickCount: number) => void;
    // Scrolls the page by this many client pixels at a point: positive `dy` shows what is further down.
    readonly scroll: (dx: number, dy: number, at: Point) => void;
    readonly zoom: {
        readonly begin: (x: number, y: number, spread: number) => void;
        readonly pinch: (x: number, y: number, spread: number) => void;
        readonly pan: (dx: number, dy: number) => readonly [number, number];
    };
    // Trackpad mode keeps its cursor inside this box (the picture), in client pixels.
    readonly bounds: () => { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | undefined;
    // Trackpad mode's cursor moved; undefined when it is put away.
    readonly cursor?: (at: Point | undefined) => void;
    readonly now: () => number;
    readonly later: (run: () => void, ms: number) => () => void;
    // A tick in the hand when a long press fires, where the device has one.
    readonly buzz?: () => void;
}

export interface TouchGestures {
    readonly down: (event: TouchPoint) => void;
    readonly move: (event: TouchPoint) => void;
    readonly up: (event: TouchPoint) => void;
    readonly cancel: (event: TouchPoint) => void;
    readonly setTrackpad: (on: boolean) => void;
}

// `pending`: one finger down, not yet a tap, a drag or a long press. `two`: two fingers down, not yet a scroll or a
// pinch. `glide`: trackpad mode, one finger moving the cursor. `done`: the gesture spoke; the rest of it is ignored.
type Mode = `pending` | `drag` | `glide` | `two` | `scroll` | `pinch` | `done`;

const centroid = (points: ReadonlyMap<number, Point>): Point => {
    let x = 0;
    let y = 0;
    for (const point of points.values()) {
        x += point.x;
        y += point.y;
    }
    return { x: x / points.size, y: y / points.size };
};

// The fingers' mean distance from their centroid (half the gap, for two).
const spreadOf = (points: ReadonlyMap<number, Point>): number => {
    const middle = centroid(points);
    let total = 0;
    for (const point of points.values()) {
        total += Math.hypot(point.x - middle.x, point.y - middle.y);
    }
    return total / points.size;
};

// One touch surface's gesture so far.
interface Gesture {
    readonly hooks: TouchHooks;
    readonly points: Map<number, Point>;
    trackpad: boolean;
    mode: Mode | undefined;
    // Where the first finger landed.
    start: Point;
    cancelPress: (() => void) | undefined;
    lastMiddle: Point;
    startMiddle: Point;
    startSpread: number;
    lastTap: { readonly x: number; readonly y: number; readonly at: number; readonly count: number };
    // Trackpad mode: the cursor, and where the finger was (and when) at its last move.
    cursor: Point | undefined;
    finger: { readonly x: number; readonly y: number; readonly at: number };
    // When the second finger landed.
    twoAt: number;
}

const click = (gesture: Gesture, at: Point, button: number, count: number): void => {
    gesture.hooks.pointer(`move`, at, button, 0, 0);
    gesture.hooks.pointer(`down`, at, button, button === RIGHT ? 2 : LEFT_HELD, count);
    gesture.hooks.pointer(`up`, at, button, 0, count);
};

const clampToPicture = (gesture: Gesture, at: Point): Point => {
    const box = gesture.hooks.bounds();
    return box === undefined ? at : { x: Math.min(box.right - 1, Math.max(box.left, at.x)), y: Math.min(box.bottom - 1, Math.max(box.top, at.y)) };
};

// Trackpad mode's cursor, put where the first finger landed the first time it is needed.
const cursorAt = (gesture: Gesture): Point => {
    gesture.cursor ??= clampToPicture(gesture, gesture.start);
    return gesture.cursor;
};

// Trackpad mode: the cursor moves as far as the finger did, further when it is fast.
const glide = (gesture: Gesture, point: Point, at: number): void => {
    const dx = point.x - gesture.finger.x;
    const dy = point.y - gesture.finger.y;
    const gain = Math.min(MAX_GAIN, 1 + (ACCEL * Math.hypot(dx, dy)) / Math.max(1, at - gesture.finger.at));
    gesture.finger = { x: point.x, y: point.y, at };
    const from = cursorAt(gesture);
    gesture.cursor = clampToPicture(gesture, { x: from.x + dx * gain, y: from.y + dy * gain });
    gesture.hooks.cursor?.(gesture.cursor);
    gesture.hooks.pointer(`move`, gesture.cursor, LEFT, gesture.mode === `drag` ? LEFT_HELD : 0, 0);
};

// Measures the gesture from where the fingers are now, after one landed or lifted.
const rebase = (gesture: Gesture): void => {
    gesture.startMiddle = gesture.lastMiddle = centroid(gesture.points);
    gesture.startSpread = spreadOf(gesture.points);
    if (gesture.mode === `pinch`) {
        gesture.hooks.zoom.begin(gesture.startMiddle.x, gesture.startMiddle.y, gesture.startSpread);
    }
};

const endDrag = (gesture: Gesture): void => {
    if (gesture.mode === `drag`) {
        gesture.hooks.pointer(`up`, gesture.trackpad ? cursorAt(gesture) : gesture.lastMiddle, LEFT, 0, 1);
    }
};

// A finger held still: a right click, or in trackpad mode the button going down where the cursor is, to drag from.
const longPress = (gesture: Gesture): void => {
    if (gesture.mode !== `pending`) {
        return;
    }
    if (gesture.trackpad) {
        gesture.hooks.pointer(`down`, cursorAt(gesture), LEFT, LEFT_HELD, 1);
        gesture.mode = `drag`;
    } else {
        click(gesture, gesture.start, RIGHT, 1);
        gesture.mode = `done`;
    }
    gesture.hooks.buzz?.();
};

// Two fingers: a pinch changes their gap faster than it moves their centroid, a scroll moves them together.
const twoFingers = (gesture: Gesture): void => {
    const middle = centroid(gesture.points);
    if (gesture.mode === `two`) {
        const moved = Math.hypot(middle.x - gesture.startMiddle.x, middle.y - gesture.startMiddle.y);
        const gap = 2 * Math.abs(spreadOf(gesture.points) - gesture.startSpread);
        if (gap > TAP_SLOP && gap > moved) {
            gesture.mode = `pinch`;
            rebase(gesture);
        } else if (moved > TAP_SLOP) {
            gesture.mode = `scroll`;
        }
    }
    if (gesture.mode === `pinch`) {
        gesture.hooks.zoom.pinch(middle.x, middle.y, spreadOf(gesture.points));
    } else if (gesture.mode === `scroll`) {
        const [restX, restY] = gesture.hooks.zoom.pan(middle.x - gesture.lastMiddle.x, middle.y - gesture.lastMiddle.y);
        // Fingers moving up show what is further down.
        if (restX !== 0 || restY !== 0) {
            gesture.hooks.scroll(-restX, -restY, middle);
        }
        gesture.lastMiddle = middle;
    }
};

// A tap: a click where the finger landed, or where the last tap clicked if this is its second (a double click). In
// trackpad mode the cursor stays put between taps, so a double tap double-clicks without help.
const tap = (gesture: Gesture): void => {
    const now = gesture.hooks.now();
    const { lastTap } = gesture;
    const soon = now - lastTap.at < MULTI_TAP_MS;
    const at = gesture.trackpad ? cursorAt(gesture) : gesture.start;
    const again = soon && (gesture.trackpad || Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < MULTI_TAP_PX);
    const aimed = again ? { x: lastTap.x, y: lastTap.y } : at;
    const count = again ? Math.min(3, lastTap.count + 1) : 1;
    gesture.lastTap = { ...aimed, at: now, count };
    click(gesture, aimed, LEFT, count);
};

const down = (gesture: Gesture, event: TouchPoint): void => {
    const point = { x: event.clientX, y: event.clientY };
    gesture.points.set(event.pointerId, point);
    if (gesture.points.size === 1) {
        gesture.mode = `pending`;
        gesture.start = point;
        gesture.lastMiddle = point;
        gesture.finger = { ...point, at: event.timeStamp };
        gesture.cancelPress = gesture.hooks.later(() => longPress(gesture), LONG_PRESS_MS);
        return;
    }
    if (gesture.points.size === 2) {
        gesture.cancelPress?.();
        endDrag(gesture);
        gesture.mode = `two`;
        gesture.twoAt = event.timeStamp;
    }
    rebase(gesture);
};

const move = (gesture: Gesture, event: TouchPoint): void => {
    if (!gesture.points.has(event.pointerId)) {
        return;
    }
    const now = { x: event.clientX, y: event.clientY };
    gesture.points.set(event.pointerId, now);
    const { start } = gesture;
    if (gesture.mode === `pending` && Math.hypot(now.x - start.x, now.y - start.y) > TAP_SLOP) {
        gesture.cancelPress?.();
        gesture.mode = gesture.trackpad ? `glide` : `drag`;
        if (!gesture.trackpad) {
            gesture.hooks.pointer(`move`, start, LEFT, 0, 0);
            gesture.hooks.pointer(`down`, start, LEFT, LEFT_HELD, 1);
        }
    }
    if (gesture.mode === `glide` || (gesture.mode === `drag` && gesture.trackpad)) {
        glide(gesture, now, event.timeStamp);
    } else if (gesture.mode === `drag`) {
        gesture.lastMiddle = now;
        gesture.hooks.pointer(`move`, now, LEFT, LEFT_HELD, 0);
    }
    if (gesture.points.size >= 2) {
        twoFingers(gesture);
    }
};

const up = (gesture: Gesture, event: TouchPoint): void => {
    if (!gesture.points.delete(event.pointerId)) {
        return;
    }
    const { mode } = gesture;
    if (mode === `pending`) {
        gesture.cancelPress?.();
        tap(gesture);
        gesture.mode = `done`;
    } else if (mode === `drag` || mode === `glide`) {
        endDrag(gesture);
        gesture.mode = `done`;
    } else if (mode === `two` && gesture.trackpad && gesture.points.size === 1 && event.timeStamp - gesture.twoAt < TWO_TAP_MS) {
        click(gesture, cursorAt(gesture), RIGHT, 1);
        gesture.mode = `done`;
    } else if (mode === `two` || mode === `scroll` || mode === `pinch`) {
        if (gesture.points.size < 2) {
            gesture.mode = `done`;
        } else {
            rebase(gesture);
        }
    }
    if (gesture.points.size === 0) {
        gesture.mode = undefined;
    }
};

// Ends a gesture in progress without finishing it: a held button is released, and the rest of it is ignored.
const abandon = (gesture: Gesture): void => {
    gesture.cancelPress?.();
    endDrag(gesture);
    gesture.mode = gesture.points.size > 0 ? `done` : undefined;
};

export const touchGestures = (hooks: TouchHooks): TouchGestures => {
    const origin = { x: 0, y: 0 };
    const gesture: Gesture = {
        hooks,
        points: new Map(),
        trackpad: false,
        mode: undefined,
        start: origin,
        cancelPress: undefined,
        lastMiddle: origin,
        startMiddle: origin,
        startSpread: 0,
        lastTap: { ...origin, at: -Infinity, count: 0 },
        cursor: undefined,
        finger: { ...origin, at: 0 },
        twoAt: 0,
    };
    return {
        down: (event) => down(gesture, event),
        move: (event) => move(gesture, event),
        up: (event) => up(gesture, event),
        cancel: (event) => {
            gesture.points.delete(event.pointerId);
            abandon(gesture);
        },
        setTrackpad: (on) => {
            abandon(gesture);
            gesture.trackpad = on;
            // The cursor starts in the middle of the picture, and goes away with the mode.
            const box = on ? hooks.bounds() : undefined;
            gesture.cursor = box === undefined ? undefined : { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
            hooks.cursor?.(gesture.cursor);
        },
    };
};

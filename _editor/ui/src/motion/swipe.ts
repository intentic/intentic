// WHAT A FINGER MEANT, read from where it went. The arithmetic every swipe on a phone shares, kept free of the DOM so it
// can be pinned by tests: which way a touch is going once it has gone far enough to say, how fast it was going when it
// let go, how far a drag past the end stretches, and whether a release commits or springs back.
//
// A swipe and the page's own scroll start the same way, so the page wins every tie: a touch is horizontal only when it
// is clearly more sideways than down, and until it has travelled AXIS_SLOP_PX it is nothing yet.

export type Axis = `x` | `y`;

/** How far a touch travels before its direction is read: under the browser's own scroll slop, so the swipe decides first. */
export const AXIS_SLOP_PX = 8;
// Sideways must beat vertical by this much: a diagonal thumb on a list is a scroll.
const SIDEWAYS_BIAS = 1.2;

/** The axis a touch is moving along, or undefined while it is still within the slop. */
export const lockAxis = (dx: number, dy: number, slop = AXIS_SLOP_PX): Axis | undefined => {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (Math.max(ax, ay) < slop) {
        return undefined;
    }
    return ax > ay * SIDEWAYS_BIAS ? `x` : `y`;
};

// Only the last stretch of the movement speaks for the release: a drag that started fast and slowed is a slow release.
const VELOCITY_WINDOW_MS = 100;
// A finger held still this long before lifting has stopped, whatever it did before.
const PAUSE_MS = 60;

export interface VelocityTracker {
    /** One position along the axis, at a timestamp in ms (`event.timeStamp`). */
    push(t: number, at: number): void;
    /** Speed along the axis at `now`, in px/ms; 0 once the finger has paused. */
    velocity(now: number): number;
    reset(): void;
}

export const velocityTracker = (): VelocityTracker => {
    const samples: { t: number; at: number }[] = [];
    return {
        push(t, at) {
            samples.push({ t, at });
            // Keep what the window can still use, and always the two newest.
            while (samples.length > 2 && t - samples[0]!.t > VELOCITY_WINDOW_MS) {
                samples.shift();
            }
        },
        velocity(now) {
            const last = samples[samples.length - 1];
            if (last === undefined || now - last.t > PAUSE_MS) {
                return 0;
            }
            const first = samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ?? last;
            const dt = last.t - first.t;
            return dt <= 0 ? 0 : (last.at - first.at) / dt;
        },
        reset() {
            samples.length = 0;
        },
    };
};

/**
 * How far something dragged `overshoot` px past where it may go is drawn: the further, the less each pixel moves it,
 * never reaching `dimension`. The curve UIScrollView stretches by.
 */
export const rubberBand = (overshoot: number, dimension: number, constant = 0.55): number => {
    if (dimension <= 0) {
        return 0;
    }
    const magnitude = (1 - 1 / ((Math.abs(overshoot) * constant) / dimension + 1)) * dimension;
    return Math.sign(overshoot) * magnitude;
};

// How far ahead a release is projected, in ms of its own speed: where a flick would have carried the thing had it kept going.
const PROJECTION_MS = 200;
// A flick still has to be a movement: a twitch at speed is not a swipe.
const MIN_TRAVEL_PX = 12;

export interface Release {
    /** How far it travelled toward committing, px (negative is back past its start). */
    readonly travel: number;
    /** Its speed at release toward committing, px/ms (negative is heading back). */
    readonly velocity: number;
    /** The full length of the gesture, px: the row's width, the screen's. */
    readonly extent: number;
}

/**
 * Whether a release commits: where it was heading, projected a moment ahead, is past `fraction` of the way. So a slow
 * drag commits past the line, a flick commits well short of it, and a flick back cancels even from far out.
 */
export const commits = (release: Release, fraction: number): boolean =>
    release.travel >= MIN_TRAVEL_PX && release.travel + release.velocity * PROJECTION_MS >= release.extent * fraction;

/** One short buzz where the phone has `navigator.vibrate` (Android's Chrome, not Safari): a threshold crossed, never a move. */
export const tick = (): void => {
    if (typeof navigator !== `undefined` && typeof navigator.vibrate === `function`) {
        try {
            navigator.vibrate(8);
        } catch {
            // allow(silent-catch): refused before the first user gesture, or by a policy; a missing tick is not an error.
        }
    }
};

import { lessMotion } from "./choice.js";

// A SPRING, PLAYED ON THE COMPOSITOR. What a finger lets go of keeps the speed it had: a card flung off at 2px/ms leaves
// at 2px/ms and slows, one let go of mid-air drifts back from standing still. A bezier cannot start at a given speed, and
// a spring stepped from script runs on the main thread, which is busy in exactly that frame (the press's own render). So
// the spring is solved once, on release, and handed to the Web Animations API as a `linear()` easing sampled from it:
// the compositor plays a curve with the release speed in its first segment and the settle in its tail, and nothing
// runs per frame on the main thread. Browsers without `linear()` get the board's own ease-out over the settle's length.

export interface Spring {
    /** Pull toward rest per unit mass, s⁻². */
    readonly stiffness: number;
    /** Damping ratio: 1 settles without passing rest, under 1 overshoots and comes back. */
    readonly damping: number;
}

/** Back to where it stood: firm, and never past it, since past it is a sliver of whatever lies underneath. */
export const SETTLE: Spring = { stiffness: 420, damping: 1 };
/** Off the screen: the finger's speed carried out, a touch softer so a slow release still reads as going. */
export const FLING: Spring = { stiffness: 300, damping: 1 };
/** A surface arriving: a hair of overshoot, so it lands rather than stops. */
export const ARRIVE: Spring = { stiffness: 340, damping: 0.86 };

export interface SpringTiming {
    readonly duration: number;
    readonly easing: string;
}

// Rest is reached when the remaining distance is under this share of the travel and stays there.
const REST = 0.0015;
const SAMPLE_S = 1 / 240;
const LONGEST_S = 1.2;
// One point of the `linear()` curve every this many seconds: dense enough that the release's speed is the first segment's slope.
const POINT_S = 1 / 120;

/** Where a spring released at `velocity` (travels per second, toward rest positive) stands at `t` seconds, 0 → 1. */
export const springAt = (spring: Spring, velocity: number, t: number): number => {
    const omega = Math.sqrt(spring.stiffness);
    const zeta = spring.damping;
    // The displacement from rest starts at -1 and moves at `velocity`.
    const d0 = -1;
    if (zeta < 1) {
        const omegaD = omega * Math.sqrt(1 - zeta * zeta);
        const b = (velocity + zeta * omega * d0) / omegaD;
        return 1 + Math.exp(-zeta * omega * t) * (d0 * Math.cos(omegaD * t) + b * Math.sin(omegaD * t));
    }
    if (zeta === 1) {
        return 1 + Math.exp(-omega * t) * (d0 + (velocity + omega * d0) * t);
    }
    const root = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega * (zeta - root);
    const r2 = -omega * (zeta + root);
    const c2 = (velocity - r1 * d0) / (r2 - r1);
    const c1 = d0 - c2;
    return 1 + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
};

/** How long the spring takes to come to rest, in seconds. */
export const springSettles = (spring: Spring, velocity: number): number => {
    let calm = 0;
    for (let t = SAMPLE_S; t < LONGEST_S; t += SAMPLE_S) {
        calm = Math.abs(1 - springAt(spring, velocity, t)) < REST ? calm + 1 : 0;
        // A tenth of a second at rest: an underdamped spring crossing rest mid-swing is not resting.
        if (calm * SAMPLE_S >= 0.1) {
            return Math.max(SAMPLE_S, t - 0.1);
        }
    }
    return LONGEST_S;
};

/** When the spring first gets `share` of the way, in seconds: where a fling leaves the screen, long before it rests. */
export const springReaches = (spring: Spring, velocity: number, share: number): number => {
    for (let t = 0; t < LONGEST_S; t += SAMPLE_S) {
        if (springAt(spring, velocity, t) >= share) {
            return t;
        }
    }
    return springSettles(spring, velocity);
};

/** A release's speed in px/ms toward a target `distance` px away, as the spring counts it: travels per second, capped so a jittery last sample cannot whip it. */
export const travelsPerSecond = (velocity: number, distance: number): number =>
    Math.abs(distance) < 0.5 ? 0 : Math.max(-40, Math.min(40, (velocity * 1000) / Math.abs(distance)));

/** The spring as `linear()` stops, 0 to 1, one every POINT_S. */
export const springPoints = (spring: Spring, velocity: number): number[] => {
    const settles = springSettles(spring, velocity);
    const count = Math.max(2, Math.ceil(settles / POINT_S) + 1);
    const points: number[] = [];
    for (let i = 0; i < count; i += 1) {
        const at = i === count - 1 ? 1 : springAt(spring, velocity, (settles * i) / (count - 1));
        points.push(Math.round(at * 10_000) / 10_000);
    }
    return points;
};

// Asked once: `linear()` is a fact about the browser, not about the moment.
let linearEasing: boolean | undefined;
const supportsLinear = (): boolean => {
    linearEasing ??= typeof CSS !== `undefined` && typeof CSS.supports === `function` && CSS.supports(`animation-timing-function`, `linear(0, 1)`);
    return linearEasing;
};

/**
 * The timing for travelling `distance` px from a release at `velocity` px/ms (positive toward the target), on `spring`:
 * hand it to `el.animate(frames, timing)`. Instant for a reader who asked for less motion.
 */
export const springTiming = (distance: number, velocity: number, spring: Spring): SpringTiming => {
    if (lessMotion() || Math.abs(distance) < 0.5) {
        return { duration: 0, easing: `linear` };
    }
    const normalized = travelsPerSecond(velocity, distance);
    const settles = springSettles(spring, normalized);
    if (!supportsLinear()) {
        return { duration: Math.round(settles * 700), easing: `cubic-bezier(0.2, 0, 0, 1)` };
    }
    return { duration: Math.round(settles * 1000), easing: `linear(${springPoints(spring, normalized).join(`, `)})` };
};

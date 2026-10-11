import {
    ARRIVE,
    commits,
    FLING,
    lockAxis,
    rubberBand,
    SETTLE,
    springAt,
    springPoints,
    springReaches,
    springSettles,
    springTiming,
    travelsPerSecond,
    useMotion,
    velocityTracker,
} from "@intentic/ui/motion";

// Pins the arithmetic every swipe on a phone shares (motion/swipe.ts) and the spring a release is played on
// (motion/spring.ts): the page's scroll wins every tie, a finger that paused before lifting was not flicking, a drag past
// an end stretches but never reaches it, a flick commits short of the line and a flick back cancels from past it, and a
// spring starts at the release's speed, ends where it was going, and is instant for a reader who asked for less motion.

describe(`reading a touch`, () => {
    it(`decides nothing inside the slop, and gives a tie to the page's scroll`, () => {
        expect(lockAxis(5, 3)).toBeUndefined();
        expect(lockAxis(-12, 2)).toBe(`x`);
        expect(lockAxis(2, 14)).toBe(`y`);
        // Diagonal: only clearly sideways is a swipe.
        expect(lockAxis(10, 9)).toBe(`y`);
        expect(lockAxis(13, 9)).toBe(`x`);
    });

    it(`measures the release over the last stretch, and a pause before lifting as standing still`, () => {
        const track = velocityTracker();
        // Slow for a long while, then a quick last 60ms: the quick part is the release.
        track.push(0, 0);
        track.push(200, 20);
        track.push(230, 50);
        track.push(260, 80);
        expect(track.velocity(260)).toBeCloseTo(1, 5);
        // The same movement, held still for 80ms before the finger lifts.
        expect(track.velocity(340)).toBe(0);
        track.reset();
        expect(track.velocity(0)).toBe(0);
    });

    it(`stretches a drag past the end less and less, never as far as the dimension`, () => {
        const one = rubberBand(50, 300);
        const two = rubberBand(100, 300);
        expect(one).toBeGreaterThan(0);
        expect(one).toBeLessThan(50);
        expect(two - one).toBeLessThan(one);
        expect(rubberBand(100_000, 300)).toBeLessThan(300);
        expect(rubberBand(-50, 300)).toBe(-one);
        expect(rubberBand(50, 0)).toBe(0);
    });
});

describe(`deciding a release`, () => {
    const extent = 400;

    it(`commits a slow drag past the line and springs back one short of it`, () => {
        expect(commits({ travel: 170, velocity: 0, extent }, 0.4)).toBe(true);
        expect(commits({ travel: 150, velocity: 0, extent }, 0.4)).toBe(false);
    });

    it(`commits a flick well short of the line, and cancels a flick back from past it`, () => {
        expect(commits({ travel: 40, velocity: 0.8, extent }, 0.4)).toBe(true);
        expect(commits({ travel: 220, velocity: -0.6, extent }, 0.4)).toBe(false);
    });

    it(`never commits a twitch, however fast`, () => {
        expect(commits({ travel: 6, velocity: 3, extent }, 0.4)).toBe(false);
    });
});

describe(`the spring`, () => {
    it(`starts where it was let go, ends where it was going, and never passes it when critically damped`, () => {
        for (const velocity of [0, 4, -3]) {
            expect(springAt(SETTLE, velocity, 0)).toBeCloseTo(0, 6);
            const points = springPoints(SETTLE, velocity);
            expect(points[0]).toBe(0);
            expect(points[points.length - 1]).toBe(1);
            expect(Math.max(...points)).toBeLessThanOrEqual(1.0015);
        }
    });

    it(`leaves at the speed it was released with`, () => {
        const dt = 0.001;
        expect(springAt(FLING, 6, dt) / dt).toBeCloseTo(6, 0);
        expect(springAt(FLING, 0, dt) / dt).toBeCloseTo(0, 0);
    });

    it(`overshoots a hair and comes back when underdamped`, () => {
        const peak = Math.max(...springPoints(ARRIVE, 0));
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThan(1.05);
    });

    it(`settles sooner when flung toward its rest than when let go standing`, () => {
        expect(springSettles(FLING, 0)).toBeLessThan(0.6);
        expect(springReaches(FLING, 8, 0.9)).toBeLessThan(springReaches(FLING, 0, 0.9));
    });

    it(`counts a release in travels per second, capped against a jittery last sample`, () => {
        expect(travelsPerSecond(0.5, 250)).toBe(2);
        expect(travelsPerSecond(0.5, -250)).toBe(2);
        expect(travelsPerSecond(50, 10)).toBe(40);
        expect(travelsPerSecond(1, 0)).toBe(0);
    });

    it(`is a timing the compositor can play, and nothing at all for a reader who asked for less motion`, () => {
        const { setMotion } = useMotion();
        setMotion(`on`);
        const timing = springTiming(300, 1.2, SETTLE);
        expect(timing.duration).toBeGreaterThan(0);
        expect(timing.duration).toBeLessThan(1200);
        expect(springTiming(0.2, 1, SETTLE).duration).toBe(0);
        setMotion(`off`);
        expect(springTiming(300, 1.2, SETTLE)).toEqual({ duration: 0, easing: `linear` });
        setMotion(`system`);
    });
});

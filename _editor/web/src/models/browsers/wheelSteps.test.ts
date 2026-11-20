// A trackpad's scroll is many small fractional steps; a mouse wheel's is a few big ones in lines or pixels. Both must
// reach the page at their size, a frame at a time, losing nothing.
import { LINE_PX, wheelCoalescer, wheelPixels, type ScrollStep } from "./wheelSteps";

// A frame clock the test advances by hand.
const frames = () => {
    let queued: (() => void) | undefined;
    return {
        frame: (flush: () => void) => {
            queued = flush;
            return () => {
                queued = undefined;
            };
        },
        tick: () => {
            const run = queued;
            queued = undefined;
            run?.();
        },
        waiting: () => queued !== undefined,
    };
};

const coalesced = () => {
    const clock = frames();
    const sent: ScrollStep[] = [];
    const wheel = wheelCoalescer((step) => sent.push(step), clock.frame);
    return { sent, wheel, clock };
};

describe("wheelPixels", () => {
    test("pixels pass as they are, lines are Chromium's line step, and pages are the view's height", () => {
        expect(wheelPixels({ deltaX: 0.5, deltaY: -2.25, deltaMode: 0 }, 700)).toEqual({ dx: 0.5, dy: -2.25 });
        // Firefox's mouse wheel: three lines a notch.
        expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 700)).toEqual({ dx: 0, dy: 3 * LINE_PX });
        expect(wheelPixels({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 700)).toEqual({ dx: 0, dy: -700 });
    });
});

describe("wheelCoalescer", () => {
    test("a frame's steps go as one, at the latest point, with their deltas summed", () => {
        const { sent, wheel, clock } = coalesced();
        wheel.add({ x: 10, y: 10, dx: 0, dy: 1.5 });
        wheel.add({ x: 11, y: 12, dx: 0.25, dy: 2.5 });
        expect(sent).toEqual([]);
        clock.tick();
        expect(sent).toEqual([{ x: 11, y: 12, dx: 0.25, dy: 4 }]);
    });

    // Rounding each step to a notch, as the display did, scrolled a slow trackpad nothing at all.
    test("steps too small to send are carried until they add up, never dropped", () => {
        const { sent, wheel, clock } = coalesced();
        for (let index = 0; index < 3; index++) {
            wheel.add({ x: 0, y: 0, dx: 0, dy: 0.004 });
            clock.tick();
        }
        expect(sent).toEqual([{ x: 0, y: 0, dx: 0, dy: 0.01 }]);
        // What the hundredth left behind is still owed.
        wheel.add({ x: 0, y: 0, dx: 0, dy: 0.008 });
        clock.tick();
        expect(sent.at(-1)?.dy).toBe(0.01);
    });

    test("a sum of fractions arrives whole over many frames", () => {
        const { sent, wheel, clock } = coalesced();
        for (let index = 0; index < 100; index++) {
            wheel.add({ x: 0, y: 0, dx: 0.333, dy: -0.777 });
            clock.tick();
        }
        const total = sent.reduce((sum, step) => ({ dx: sum.dx + step.dx, dy: sum.dy + step.dy }), { dx: 0, dy: 0 });
        expect(total.dx).toBeCloseTo(33.3, 6);
        expect(total.dy).toBeCloseTo(-77.7, 6);
    });

    // Ctrl+wheel zooms and a plain wheel scrolls; summed into one they would do neither right.
    test("a change of modifiers sends what the frame held first", () => {
        const { sent, wheel, clock } = coalesced();
        wheel.add({ x: 0, y: 0, dx: 0, dy: 50 });
        wheel.add({ x: 0, y: 0, dx: 0, dy: -100, ctrl: true });
        expect(sent).toEqual([{ x: 0, y: 0, dx: 0, dy: 50 }]);
        clock.tick();
        expect(sent).toEqual([
            { x: 0, y: 0, dx: 0, dy: 50 },
            { x: 0, y: 0, dx: 0, dy: -100, ctrl: true },
        ]);
    });

    test("cancelling forgets the frame waiting to go", () => {
        const { sent, wheel, clock } = coalesced();
        wheel.add({ x: 0, y: 0, dx: 0, dy: 5 });
        wheel.cancel();
        expect(clock.waiting()).toBe(false);
        clock.tick();
        expect(sent).toEqual([]);
    });
});

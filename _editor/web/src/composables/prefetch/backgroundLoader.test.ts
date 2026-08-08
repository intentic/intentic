import { describe, expect, it } from "vitest";
import { gapAfter, runBackgroundLoader, type LoaderBeat, type LoaderGates, type LoaderPace } from "./backgroundLoader";
import type { WarmBand, WarmTask } from "./warmPlan";

/* The loop is driven by hand here — every idle callback and every wait is released by the test rather than
 * waited out — so the pacing is ASSERTED instead of slept through. `now` is a counter the test advances, which
 * is a complete implementation of what the loop uses it for (durations, and nothing else). */

interface Harness {
    readonly pace: LoaderPace;
    // Release one idle callback and let every microtask it queues settle.
    readonly step: () => Promise<void>;
    // Every wait the loop has asked for, in order.
    readonly waits: number[];
    readonly advance: (ms: number) => void;
}

const harness = (): Harness => {
    let releaseIdle: (() => void) | undefined;
    const waits: number[] = [];
    let clock = 0;
    return {
        waits,
        advance: (ms) => {
            clock += ms;
        },
        pace: {
            idle: () =>
                new Promise<void>((resolve) => {
                    releaseIdle = resolve;
                }),
            // Recorded, not honoured: the loop's next step is gated on `idle`, which the test releases, so a
            // wait that actually slept would only make the suite slow.
            wait: (ms) => {
                waits.push(ms);
                return Promise.resolve();
            },
            now: () => clock,
        },
        step: async () => {
            releaseIdle?.();
            releaseIdle = undefined;
            // A macrotask, so every microtask the released step queues (the read, its settle handler) has run by
            // the time the assertion after it does.
            await new Promise((resolve) => setTimeout(resolve, 0));
        },
    };
};

const OPEN: LoaderGates = { paused: () => false, busy: () => false };

const BANDS: readonly WarmBand[] = [`now`, `near`, `work`, `rail`];

// A wish that is satisfied once it has been read — the shape every real source builds, since `have` is a cache
// lookup and the read is what fills the cache. Reads append to `log`, which is what every assertion below is
// about: WHAT the loop read, and in WHAT ORDER.
const task = (log: string[], key: string, band: WarmBand, onRead: () => void = () => undefined): WarmTask => {
    let held = false;
    return {
        key,
        band,
        have: () => held,
        read: () => {
            onRead();
            log.push(key);
            held = true;
            return Promise.resolve();
        },
    };
};

const dead = (key: string): WarmTask => ({ key, band: `now`, have: () => false, read: () => Promise.reject(new Error(`daemon said no`)) });

describe(`the background loader`, () => {
    it(`reads one thing at a time, in band order`, async () => {
        const read: string[] = [];
        const plan = [task(read, `rail-a`, `rail`), task(read, `near-a`, `near`), task(read, `now-a`, `now`), task(read, `work-a`, `work`)];
        const bench = harness();
        let stopped = false;
        void runBackgroundLoader(
            // Sorted by band the way warmPlan does; the loop itself only ever takes the first unsatisfied one.
            () => [...plan].sort((left, right) => BANDS.indexOf(left.band) - BANDS.indexOf(right.band)),
            OPEN,
            bench.pace,
            () => stopped,
        );

        await bench.step();
        expect(read).toEqual([`now-a`]);
        await bench.step();
        expect(read).toEqual([`now-a`, `near-a`]);
        await bench.step();
        await bench.step();
        expect(read).toEqual([`now-a`, `near-a`, `work-a`, `rail-a`]);
        stopped = true;
    });

    it(`skips what is already in hand without spending a beat on it`, async () => {
        const read: string[] = [];
        const plan = [
            { key: `held`, band: `now` as WarmBand, have: () => true, read: () => Promise.reject(new Error(`must not be read`)) },
            task(read, `cold`, `now`),
        ];
        const bench = harness();
        let stopped = false;
        void runBackgroundLoader(
            () => plan,
            OPEN,
            bench.pace,
            () => stopped,
        );

        await bench.step();
        expect(read).toEqual([`cold`]);
        stopped = true;
    });

    it(`spaces itself out in proportion to what the last read cost`, async () => {
        const bench = harness();
        const read: string[] = [];
        let stopped = false;
        // The read takes 900ms of the injected clock.
        const slow = task(read, `slow`, `now`, () => bench.advance(900));
        void runBackgroundLoader(
            () => [slow],
            OPEN,
            bench.pace,
            () => stopped,
        );

        await bench.step();
        expect(bench.waits).toEqual([900]);
        stopped = true;
    });

    it(`stands aside while the app is busy, and never opens a request beside one`, async () => {
        const read: string[] = [];
        let busy = true;
        const bench = harness();
        let stopped = false;
        void runBackgroundLoader(
            () => [task(read, `a`, `now`)],
            { paused: () => false, busy: () => busy },
            bench.pace,
            () => stopped,
        );

        await bench.step();
        expect(read).toEqual([]);
        await bench.step();
        expect(read).toEqual([]);
        busy = false;
        await bench.step();
        expect(read).toEqual([`a`]);
        stopped = true;
    });

    it(`takes its beat anyway rather than yielding forever to a request that never lands`, async () => {
        const read: string[] = [];
        const bench = harness();
        let stopped = false;
        // A plan rebuilt per beat would hand back a fresh (unread) task each time; one instance, so `have`
        // latches the way a cache does.
        const only = task(read, `a`, `now`);
        void runBackgroundLoader(
            () => [only],
            // Permanently busy — a hung daemon read with nothing to time it out.
            { paused: () => false, busy: () => true },
            bench.pace,
            () => stopped,
        );

        // Ten yields, then the loop proceeds regardless.
        for (let beat = 0; beat < 10; beat += 1) {
            await bench.step();
            expect(read).toEqual([]);
        }
        await bench.step();
        expect(read).toEqual([`a`]);
        stopped = true;
    });

    it(`reads nothing at all while nobody is looking`, async () => {
        const read: string[] = [];
        let looking = false;
        const bench = harness();
        let stopped = false;
        const only = task(read, `a`, `now`);
        void runBackgroundLoader(
            () => [only],
            { paused: () => !looking, busy: () => false },
            bench.pace,
            () => stopped,
        );

        await bench.step();
        await bench.step();
        expect(read).toEqual([]);
        looking = true;
        await bench.step();
        expect(read).toEqual([`a`]);
        stopped = true;
    });

    it(`drops a failed read rather than retrying it, and sleeps off a run of them`, async () => {
        const beats: LoaderBeat[] = [];
        const bench = harness();
        let stopped = false;
        void runBackgroundLoader(
            () => [dead(`a`), dead(`b`), dead(`c`)],
            OPEN,
            bench.pace,
            () => stopped,
            (beat) => {
                beats.push(beat);
            },
        );

        await bench.step();
        await bench.step();
        await bench.step();
        expect(beats.map((beat) => beat.outcome)).toEqual([`failed`, `failed`, `failed`]);
        // The first two pace off normally; the third trips the streak and stands the loader down.
        expect(bench.waits.at(-1)).toBe(30_000);
        stopped = true;
    });

    it(`stops between beats without reading what it was about to`, async () => {
        const read: string[] = [];
        const bench = harness();
        let stopped = false;
        void runBackgroundLoader(
            () => [task(read, `a`, `now`)],
            OPEN,
            bench.pace,
            () => stopped,
        );

        stopped = true;
        await bench.step();
        expect(read).toEqual([]);
    });
});

describe(`gapAfter`, () => {
    it(`floors a cheap read so a fast daemon is still asked at a trickle`, () => {
        expect(gapAfter(0)).toBe(250);
        expect(gapAfter(10)).toBe(250);
    });

    it(`scales with the cost of the read between the floor and the ceiling`, () => {
        expect(gapAfter(800)).toBe(800);
    });

    it(`caps, so one pathological read does not park the loader`, () => {
        expect(gapAfter(60_000)).toBe(4_000);
    });
});

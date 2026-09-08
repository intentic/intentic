import { describe, expect, it } from "vitest";
import { gapAfter, runBackgroundLoader, type LoaderBeat, type LoaderGates, type LoaderPace } from "./backgroundLoader";
import type { WarmBand, WarmTask } from "./warmPlan";

// The loop is driven by hand: every idle callback and wait is released by the test, not slept through.
// `now` is a counter the test advances, used only for durations.

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
            // Recorded, not honoured: the loop waits on `idle`, which the test releases.
            wait: (ms) => {
                waits.push(ms);
                return Promise.resolve();
            },
            now: () => clock,
        },
        step: async () => {
            releaseIdle?.();
            releaseIdle = undefined;
            // A macrotask: lets every microtask the released step queues finish before the following assertion.
            await new Promise((resolve) => setTimeout(resolve, 0));
        },
    };
};

const OPEN: LoaderGates = { paused: () => false, busy: () => false };

const BANDS: readonly WarmBand[] = [`now`, `near`, `work`, `rail`];

// have() flips true once read() runs, mirroring a cache a real source fills. read() appends key to log, in order.
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

// A wish whose read succeeds but leaves have() false. The app can no longer build one, but an extension
// can, so the loop must survive it.
const stalling = (log: string[], key: string): WarmTask => ({
    key,
    band: `now`,
    have: () => false,
    read: () => {
        log.push(key);
        return Promise.resolve();
    },
});

describe(`the background loader`, () => {
    it(`reads one thing at a time, in band order`, async () => {
        const read: string[] = [];
        const plan = [task(read, `rail-a`, `rail`), task(read, `near-a`, `near`), task(read, `now-a`, `now`), task(read, `work-a`, `work`)];
        const bench = harness();
        let stopped = false;
        void runBackgroundLoader(
            // Sorted by band, matching warmPlan; the loop always takes the first unsatisfied one.
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
        // One instance, not rebuilt per beat, so have() latches like a real cache.
        const only = task(read, `a`, `now`);
        void runBackgroundLoader(
            () => [only],
            // Permanently busy: simulates a read that never completes.
            { paused: () => false, busy: () => true },
            bench.pace,
            () => stopped,
        );

        // Caps at ten yields before proceeding anyway.
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
        expect(bench.waits.at(-1)).toBe(30_000);
        stopped = true;
    });

    it(`sets aside a wish that reads cleanly and is still not in hand, instead of reading it forever`, async () => {
        const read: string[] = [];
        const beats: LoaderBeat[] = [];
        const bench = harness();
        let stopped = false;
        // One instance each, not rebuilt per beat, so have() latches like a cache.
        const plan = [stalling(read, `never-settles`), task(read, `settles`, `now`)];
        void runBackgroundLoader(
            () => plan,
            OPEN,
            bench.pace,
            () => stopped,
            (beat) => {
                beats.push(beat);
            },
        );

        await bench.step();
        expect(read).toEqual([`never-settles`]);
        expect(beats.at(-1)).toEqual({ outcome: `stalled`, key: `never-settles` });

        await bench.step();
        expect(read).toEqual([`never-settles`, `settles`]);

        await bench.step();
        expect(read).toEqual([`never-settles`, `settles`]);
        expect(beats.at(-1)?.outcome).toBe(`idle`);

        // Set aside, not abandoned: retried after a minute in case the stall clears.
        bench.advance(60_000);
        await bench.step();
        expect(read).toEqual([`never-settles`, `settles`, `never-settles`]);
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

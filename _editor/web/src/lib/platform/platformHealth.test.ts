import { createPlatformHealth, isOutageStatus, PROBE_EVERY_MS, reportedFetch, type PlatformHealthDeps } from "./platformHealth";

// Pins the one reading of the platform's health: which answers are an outage, that a down reading asks again by itself
// and only while down, and that turning up again is told once.

interface Harness {
    readonly deps: PlatformHealthDeps;
    readonly scheduled: { run: () => void; ms: number; cancelled: boolean }[];
    probeAnswers: (number | Error)[];
    clock: number;
}

const harness = (): Harness => {
    const h: Harness = {
        scheduled: [],
        probeAnswers: [],
        clock: 1_000,
        deps: {
            probe: async () => {
                const next = h.probeAnswers.shift() ?? 200;
                if (next instanceof Error) {
                    throw next;
                }
                return next;
            },
            now: () => h.clock,
            schedule: (run, ms) => {
                const entry = { run, ms, cancelled: false };
                h.scheduled.push(entry);
                return () => {
                    entry.cancelled = true;
                };
            },
        },
    };
    return h;
};

describe(`which answers are an outage`, () => {
    it(`is no answer's worth of statuses: 500 and 502 through 599`, () => {
        expect([200, 401, 404, 499, 500, 501, 502, 530, 599, 600].map(isOutageStatus)).toEqual([
            false,
            false,
            false,
            false,
            true,
            false,
            true,
            true,
            true,
            false,
        ]);
    });
});

describe(`the reading`, () => {
    it(`starts unknown, turns down on an outage status, and remembers when`, () => {
        const h = harness();
        const health = createPlatformHealth(h.deps);
        expect(health.state.value).toBe(`unknown`);
        h.clock = 5_000;
        health.noteStatus(530);
        expect(health.state.value).toBe(`down`);
        expect(health.down.value).toBe(true);
        expect(health.downSince.value).toBe(5_000);
        h.clock = 9_000;
        health.noteUnreachable();
        expect(health.downSince.value).toBe(5_000);
    });

    it(`reads a refusal as the platform answering`, () => {
        const health = createPlatformHealth(harness().deps);
        health.noteStatus(401);
        expect(health.state.value).toBe(`up`);
    });

    it(`asks again only while down, one probe pending at a time`, async () => {
        const h = harness();
        const health = createPlatformHealth(h.deps);
        health.noteStatus(200);
        expect(h.scheduled).toHaveLength(0);
        health.noteUnreachable();
        health.noteStatus(502);
        expect(h.scheduled).toHaveLength(1);
        expect(h.scheduled[0]?.ms).toBe(PROBE_EVERY_MS);
        h.probeAnswers = [new Error(`offline`)];
        h.scheduled[0]?.run();
        await Promise.resolve();
        await Promise.resolve();
        expect(health.state.value).toBe(`down`);
        expect(h.scheduled).toHaveLength(2);
    });

    it(`tells each recovery once and stops probing`, async () => {
        const h = harness();
        const health = createPlatformHealth(h.deps);
        let recoveries = 0;
        health.onRecovered(() => {
            recoveries += 1;
        });
        health.noteStatus(503);
        h.probeAnswers = [200];
        expect(await health.checkNow()).toBe(`up`);
        expect(h.scheduled[0]?.cancelled).toBe(true);
        health.noteStatus(200);
        expect(recoveries).toBe(1);
        expect(health.downSince.value).toBe(undefined);
    });
});

describe(`a reported call`, () => {
    it(`reports the answer's status and hands the answer on`, async () => {
        const health = createPlatformHealth(harness().deps);
        const answer = await reportedFetch(async () => new Response(`down`, { status: 521 }), health);
        expect(answer.status).toBe(521);
        expect(health.state.value).toBe(`down`);
    });

    it(`reports a call nothing answered, and rethrows it`, async () => {
        const health = createPlatformHealth(harness().deps);
        await expect(reportedFetch(() => Promise.reject(new TypeError(`Failed to fetch`)), health)).rejects.toThrow(`Failed to fetch`);
        expect(health.state.value).toBe(`down`);
    });

    it(`leaves the reading alone for an abort the caller asked for`, async () => {
        const health = createPlatformHealth(harness().deps);
        await expect(reportedFetch(() => Promise.reject(new DOMException(`aborted`, `AbortError`)), health)).rejects.toThrow(`aborted`);
        expect(health.state.value).toBe(`unknown`);
    });
});

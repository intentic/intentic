import { desktopGauge, gaugePercent, hostedGauge, machineGauge } from "./newSandboxGauge";

const steps = [
    { key: `check`, label: `Check`, note: ``, weight: 0.2 },
    { key: `pull`, label: `Download`, note: ``, weight: 0.6 },
    { key: `start`, label: `Start`, note: ``, weight: 0.2 },
];

describe(`the new sandbox's gauge`, () => {
    it(`reads the app's own percent and words while its install runs, and nothing while it waits`, () => {
        const running = desktopGauge({ state: `running`, percent: 41.6, position: `Step 4 of 10`, remaining: `about 3 min left` });
        expect(running).toMatchObject({ position: `Step 4 of 10`, remaining: `about 3 min left` });
        expect(running.share).toBeCloseTo(0.416);
        expect(desktopGauge({ state: `waiting`, percent: 30 }).share).toBeUndefined();
        expect(desktopGauge({ state: `running`, percent: 30, remaining: `about 3 min left`, remainingSeconds: 190 }).remaining).toBe(`about 3 minutes left`);
        expect(desktopGauge({ state: `done`, percent: 97 }).share).toBe(1);
    });

    it(`reads a machine's run as the step it names, its place among the steps and the engine's measure`, () => {
        const gauge = machineGauge({ steps, stage: `pull`, measured: 0.45, status: `running`, remaining: `about 2 minutes left`, startedAt: 5 });
        expect(gauge).toEqual({ share: 0.45, step: `Download`, index: 2, count: 3, remaining: `about 2 minutes left`, startedAt: 5 });
    });

    it(`fills a machine's run only once it said it finished, and drops the time left once it stopped`, () => {
        expect(machineGauge({ steps, stage: `start`, measured: 0.9, status: `done`, remaining: undefined, startedAt: 5 }).share).toBe(1);
        expect(machineGauge({ steps, stage: `start`, measured: 1, status: `running`, remaining: undefined, startedAt: 5 }).share).toBe(0.99);
        expect(machineGauge({ steps, stage: `pull`, measured: 0.4, status: `stopped`, remaining: `soon`, startedAt: 5 }).remaining).toBeUndefined();
    });

    it(`reads a machine of ours by its steps: each passed one full, the one under way half`, () => {
        const gauge = hostedGauge([
            { key: `machine`, label: `Starting a machine`, state: `done` },
            { key: `booting`, label: `Starting the sandbox`, state: `active` },
            { key: `connecting`, label: `Putting it online`, state: `todo` },
            { key: `ready`, label: `Ready`, state: `todo` },
        ]);
        expect(gauge).toEqual({ share: 0.375, step: `Starting the sandbox`, index: 2, count: 4 });
        expect(gaugePercent(gauge)).toBe(38);
    });

    it(`says no percent where the run counts nothing`, () => {
        expect(gaugePercent(undefined)).toBeUndefined();
        expect(gaugePercent({ share: undefined })).toBeUndefined();
    });
});

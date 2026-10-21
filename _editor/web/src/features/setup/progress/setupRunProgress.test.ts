import { advance, startProgress } from "@intentic/sandbox-run/setup-progress";
import { appendedLines, machinePlan, setupRunView, stagedPlan } from "./setupRunProgress";

// The English catalog is loaded for tests, so the words are asserted as a reader sees them.

/* What a Windows PC on the Intentic engine printed for "Set it up on rog" (2026-10-21), drawn at the time as a raw log:
the credential helper's complaint and the at-rest key's path included, which the page now keeps behind "Show log". */
const RUN = [
    `intentic: [preflight] checking this device…`,
    `intentic: [claiming-code] redeeming the setup code…`,
    `intentic: [pulling-image] pulling sandbox image ghcr.io/intentic/sandbox:stable (first run can take a minute)…`,
    `error getting credentials - err: exec: "docker-credential-desktop.exe": executable file not found in $PATH, out: \`\``,
    `intentic: pull failed but the image exists locally — using the local copy.`,
    `intentic: [starting-sandbox] starting sandbox…`,
    `intentic: The credentials sandbox-bedc615644c3 stores are encrypted at rest from now on, with a key made for it.`,
    `intentic: [waiting-health] waiting for the sandbox daemon to come up…`,
];
const read = (lines: readonly string[]) => lines.reduce((state, text, at) => advance(state, { kind: `line`, text }, at * 1_000), startProgress(machinePlan(), 0));

describe(`a sandbox being set up on a connected computer`, () => {
    it(`is planned without an installer to fetch or a Docker to install, in steps sized to fill the bar`, () => {
        const steps = stagedPlan(machinePlan());
        expect(steps.map((step) => step.key)).not.toContain(`fetching-ic`);
        expect(steps.map((step) => step.key)).not.toContain(`installing-docker`);
        expect(steps[0]).toMatchObject({ key: `checking-docker`, label: `Check it can run sandboxes` });
        expect(steps.reduce((sum, step) => sum + step.weight, 0)).toBeCloseTo(1);
    });

    it(`stands on the first step, empty, before the run names one`, () => {
        expect(setupRunView(startProgress(machinePlan(), 0), 0)).toMatchObject({ status: `running`, stage: `checking-docker`, measured: 0, detail: undefined });
    });

    it(`stands on the step ic last named, saying what ic says it is doing, and ignores the rest of the output`, () => {
        const view = setupRunView(read(RUN), 8_000);
        expect(view).toMatchObject({ status: `running`, stage: `waiting-health`, detail: `waiting for the sandbox daemon to come up…` });
        expect(view.measured).toBeGreaterThan(0);
        expect(view.measured).toBeLessThan(1);
        expect(view.remaining).toMatch(/left$/);
    });

    it(`counts the image's bytes while they come`, () => {
        const pulling = read([...RUN.slice(0, 3), `      downloading the sandbox image: 400 of 2140 MB`, `      downloading the sandbox image: 812 of 2140 MB`]);
        expect(setupRunView(pulling, 3_000)).toMatchObject({ stage: `pulling-image`, detail: `812 MB of 2.1 GB downloaded` });
    });

    it(`is full once the run ends well`, () => {
        const view = setupRunView(advance(read(RUN), { kind: `exit`, ok: true }, 9_000), 9_000);
        expect(view).toMatchObject({ status: `done`, measured: 1, detail: undefined, remaining: undefined });
    });

    it(`keeps the step it stopped on, and where the bar stood, once it ends short`, () => {
        const running = read(RUN);
        const view = setupRunView(advance(running, { kind: `exit`, ok: false }, 9_000), 9_000);
        expect(view).toMatchObject({ status: `stopped`, stage: `waiting-health`, detail: undefined, remaining: undefined });
        expect(view.measured).toBe(running.percent / 100);
    });
});

describe(`the log's new lines`, () => {
    it(`are what it grew by`, () => {
        expect(appendedLines([], [`a`, `b`])).toEqual([`a`, `b`]);
        expect(appendedLines([`a`, `b`], [`a`, `b`, `c`])).toEqual([`c`]);
        expect(appendedLines([`a`, `b`], [`a`, `b`])).toEqual([]);
    });

    it(`are what it slid by, once it is full`, () => {
        expect(appendedLines([`a`, `b`, `c`], [`b`, `c`, `d`])).toEqual([`d`]);
        expect(appendedLines([`a`, `b`, `c`], [`c`, `d`, `e`])).toEqual([`d`, `e`]);
    });

    it(`are none of the old run's, when a new run's log replaces it`, () => {
        expect(appendedLines([`a`, `b`], [])).toBeUndefined();
        expect(appendedLines([`a`, `b`], [`x`])).toBeUndefined();
    });
});

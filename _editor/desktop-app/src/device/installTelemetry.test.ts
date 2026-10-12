import type { RequirementProgress, RunEvent } from "../desktop";
import { advance, progressView, startProgress, tick, type PlanStep } from "../setupPlan";
import {
    endRequirements,
    failureLine,
    foldRequirement,
    homeOf,
    openStep,
    PULL_REPORT_EVERY_MS,
    pullReportDue,
    runEnding,
    runFacts,
    scrubReason,
    secondsBetween,
    stepLeft,
    type RequirementClocks,
} from "./installTelemetry";

// Where a setup's time goes, as the funnel hears it: what each step of the plan took, how long each requirement row ran
// and how much of that it sat waiting on the person, and why a failed run failed, in words fit to send.

const PLAN: readonly PlanStep[] = [
    { phase: `fetching-ic`, label: () => `Fetch`, weight: 15 },
    { phase: `checking-docker`, label: () => `Check`, weight: 12 },
    { phase: `installing-docker`, label: () => `Install`, weight: 600 },
    { phase: `preflight`, label: () => `Preflight`, weight: 10 },
];
const step = (phase: string): RunEvent => ({ kind: `line`, run: `setup`, stream: `stdout`, text: `intentic: [${phase}] going` });
const said = (text: string, stream: `stdout` | `stderr` = `stderr`): RunEvent => ({ kind: `line`, run: `setup`, stream, text });

describe(`a step's time`, () => {
    it(`is reported for the step the cursor leaves, timed from when it entered it`, () => {
        const fresh = startProgress(PLAN, 0);
        const fetching = advance(fresh, step(`fetching-ic`), 1_000);
        // Entering the first step leaves nothing: the cursor was on no step before it.
        expect(stepLeft(fresh, fetching, 1_000)).toBeUndefined();
        const checking = advance(fetching, step(`checking-docker`), 13_450);
        expect(stepLeft(fetching, checking, 13_450)).toEqual({ step: `fetching-ic`, seconds: 12.5 });
        // A line under the running step moves nothing.
        expect(stepLeft(checking, advance(checking, said(`  ok    This PC`, `stdout`), 14_000), 14_000)).toBeUndefined();
    });

    it(`is one per step actually entered: a step the script never announced has none`, () => {
        const checking = advance(startProgress(PLAN, 0), step(`checking-docker`), 0);
        const preflight = advance(checking, step(`preflight`), 5_000);
        // Docker was there already: the install step was skipped, and only the step left is reported.
        expect(stepLeft(checking, preflight, 5_000)).toEqual({ step: `checking-docker`, seconds: 5 });
    });

    it(`at the run's end is the step it ended on, timed to the exit`, () => {
        const installing = advance(startProgress(PLAN, 0), step(`installing-docker`), 10_000);
        expect(openStep(installing, 70_049)).toEqual({ step: `installing-docker`, seconds: 60 });
        expect(openStep(startProgress(PLAN, 0), 5_000)).toBeUndefined();
    });

    it(`ends as the run did: the reader's stop, the two designed stops, then the exit`, () => {
        expect(runEnding({ ok: true, code: 0, stopped: false })).toBe(`done`);
        expect(runEnding({ ok: false, code: 1, stopped: false })).toBe(`failed`);
        expect(runEnding({ ok: false, code: 4, stopped: false })).toBe(`parked`);
        expect(runEnding({ ok: false, code: 3, stopped: false })).toBe(`consent`);
        // A stop kills the tree, which exits with no code or any code: still the reader's stop.
        expect(runEnding({ ok: false, code: null, stopped: true })).toBe(`stopped`);
        expect(runEnding({ ok: false, code: 1, stopped: true })).toBe(`stopped`);
        expect(runEnding({ ok: false, code: undefined, stopped: false })).toBe(`failed`);
    });

    it(`is counted in seconds to a tenth`, () => {
        expect(secondsBetween(0, 1_249)).toBe(1.2);
        expect(secondsBetween(0, 1_250)).toBe(1.3);
        // A clock that went backwards reads as nothing, never as negative time.
        expect(secondsBetween(5_000, 1_000)).toBe(0);
    });
});

describe(`a requirement row's time`, () => {
    const running = (id: string, needsYou = false): RequirementProgress => ({ id, state: `running`, ...(needsYou ? { needsYou: true } : {}) });

    it(`runs from its first running marker to its finish, and counts the wait on the person apart`, () => {
        let clocks: RequirementClocks = {};
        clocks = foldRequirement(clocks, running(`docker-desktop`), 0).clocks;
        clocks = foldRequirement(clocks, { ...running(`docker-desktop`), percent: 40 }, 30_000).clocks;
        // Windows asks for permission: the row waits on the person until a marker no longer says so.
        clocks = foldRequirement(clocks, running(`docker-desktop`, true), 60_000).clocks;
        clocks = foldRequirement(clocks, running(`docker-desktop`, true), 70_000).clocks;
        clocks = foldRequirement(clocks, running(`docker-desktop`), 95_000).clocks;
        const done = foldRequirement(clocks, { id: `docker-desktop`, state: `done` }, 120_000);
        expect(done.finished).toEqual({ id: `docker-desktop`, outcome: `done`, seconds: 120, waitedForYouSeconds: 35 });
        expect(done.clocks).toEqual({});
    });

    it(`that finishes while still waiting on the person counts the wait up to its finish`, () => {
        let clocks = foldRequirement({}, running(`wsl-features`, true), 1_000).clocks;
        clocks = foldRequirement(clocks, running(`wsl-features`, true), 5_000).clocks;
        expect(foldRequirement(clocks, { id: `wsl-features`, state: `failed`, detail: `refused` }, 9_000).finished).toEqual({
            id: `wsl-features`,
            outcome: `failed`,
            seconds: 8,
            waitedForYouSeconds: 8,
        });
    });

    it(`is not reported for a row that never ran`, () => {
        expect(foldRequirement({}, { id: `docker-users`, state: `done` }, 1_000)).toEqual({ clocks: {} });
    });

    it(`at the run's end is every row still running, ended the way the run was`, () => {
        let clocks = foldRequirement({}, running(`docker-running`), 0).clocks;
        clocks = foldRequirement(clocks, running(`docker-users`, true), 2_000).clocks;
        expect(endRequirements(clocks, `parked`, 10_000)).toEqual([
            { id: `docker-running`, outcome: `parked`, seconds: 10, waitedForYouSeconds: 0 },
            { id: `docker-users`, outcome: `parked`, seconds: 8, waitedForYouSeconds: 8 },
        ]);
        // A run that stopped to ask stopped its rows with it.
        expect(endRequirements(clocks, `consent`, 10_000).map((row) => row.outcome)).toEqual([`stopped`, `stopped`]);
        expect(endRequirements({}, `failed`, 10_000)).toEqual([]);
    });
});

describe(`why a run failed`, () => {
    it(`is its last error line, wherever it was said`, () => {
        const events: RunEvent[] = [
            step(`claiming-code`),
            said(`warning: the clock is 3 minutes off`),
            said(`error: the setup code is invalid or expired — refresh the platform's setup page and copy a fresh command.`),
            said(`note: the log is in ~/.intentic/logs`),
            { kind: `exit`, run: `setup`, code: 1, ok: false },
        ];
        expect(failureLine(events)).toBe(`error: the setup code is invalid or expired — refresh the platform's setup page and copy a fresh command.`);
    });

    it(`is else the last thing it said on stderr, never progress, a marker or a blank`, () => {
        const events: RunEvent[] = [
            said(`connect.ps1 : Docker Desktop could not be started`),
            said(`   `),
            said(`intentic: [pulling-image] pulling`),
            said(`0a1b2c3d4e5f: Downloading`),
            said(`intentic-requirement-state: {"id":"docker-running","state":"failed"}`),
            said(`everything is fine`, `stdout`),
        ];
        expect(failureLine(events)).toBe(`connect.ps1 : Docker Desktop could not be started`);
        expect(failureLine([said(`all good`, `stdout`)])).toBeUndefined();
    });

    it(`knows the home folder by the run's own transcript`, () => {
        expect(homeOf(`C:\\Users\\Ann Smith\\.intentic\\logs\\desktop-setup-20261008-101500.log`)).toBe(`C:\\Users\\Ann Smith`);
        expect(homeOf(`/home/ann/.intentic/logs/desktop-setup.log`)).toBe(`/home/ann`);
        expect(homeOf(undefined)).toBeUndefined();
        expect(homeOf(`/tmp/intentic-desktop-setup.log`)).toBeUndefined();
    });

    it(`is sent without the home folder, the account, an address or the code, and short`, () => {
        const home = `C:\\Users\\Ann Smith`;
        expect(
            scrubReason(`intentic-launch.exe did not answer. Details: c:\\users\\ann smith\\.intentic\\machine\\machine.log`, { home }),
        ).toBe(`intentic-launch.exe did not answer. Details: ~\\.intentic\\machine\\machine.log`);
        expect(scrubReason(`Ann Smith does not have permission to use Docker on this PC yet.`, { home })).toBe(
            `<user> does not have permission to use Docker on this PC yet.`,
        );
        expect(scrubReason(`signed in as ann.smith@example.com on code k7Q2xPz9`, { code: `k7Q2xPz9` })).toBe(`signed in as <email> on code <code>`);
        // A home the run's transcript did not name is still taken out, up to its next separator.
        expect(scrubReason(`could not read C:\\Users\\bob\\x.json or /home/eve/.config`, {})).toBe(`could not read ~\\x.json or ~/.config`);
        const long = scrubReason(`error: ${`x`.repeat(400)}\n\n  and more`, {});
        expect(long).toHaveLength(300);
        expect(long.endsWith(`…`)).toBe(true);
        expect(scrubReason(`one\n  two`, {})).toBe(`one two`);
    });
});

/* A LONG PULL, AND A RUN LEFT BEHIND: where it had got to, in numbers only. */
const PULL: readonly PlanStep[] = [
    { phase: `claiming-code`, label: () => `Claim`, weight: 5 },
    { phase: `pulling-image`, label: () => `Pull`, weight: 240 },
    { phase: `starting-sandbox`, label: () => `Start`, weight: 25 },
];
const MIB = 1024 * 1024;

describe(`a pull under way`, () => {
    const pulling = advance(advance(startProgress(PULL, 0), step(`claiming-code`), 0), step(`pulling-image`), 10_000);

    it(`reports every thirty seconds from the pull's start, and only while the pull runs`, () => {
        expect(pullReportDue(pulling, undefined, 10_000 + PULL_REPORT_EVERY_MS - 1)).toBe(false);
        expect(pullReportDue(pulling, undefined, 10_000 + PULL_REPORT_EVERY_MS)).toBe(true);
        expect(pullReportDue(pulling, 40_000, 69_999)).toBe(false);
        expect(pullReportDue(pulling, 40_000, 70_000)).toBe(true);
        // A report sent in an earlier attempt's pull says nothing about this one's clock.
        expect(pullReportDue(pulling, 5_000, 30_000)).toBe(false);
        expect(pullReportDue(advance(pulling, step(`starting-sandbox`), 50_000), undefined, 200_000)).toBe(false);
        expect(pullReportDue(advance(pulling, { kind: `exit`, run: `setup`, code: 1, ok: false }, 50_000), undefined, 200_000)).toBe(false);
    });

    it(`is told in numbers: its step, the bar, the bytes and their rate, the time it has run and the time left`, () => {
        const read = (mb: number) => said(`      downloading the sandbox image: ${mb} of 2200 MB (5.0 MB/s)`, `stdout`);
        const state = tick([0, 1, 2, 3].reduce((sofar, at) => advance(sofar, read(200 + at * 50), 20_000 + at * 10_000), pulling), 50_000);
        const facts = runFacts(state, progressView(state, 50_000), 50_000);
        expect(facts).toEqual({
            step: `pulling-image`,
            percent: expect.any(Number),
            elapsedSeconds: 50,
            stepSeconds: 40,
            layers: 0,
            downloadedMb: 350,
            downloadTotalMb: 2200,
            bytesPerSecond: 5 * MIB,
            remainingSeconds: expect.any(Number),
        });
        // Nothing but the step's id is anything but a number.
        expect(Object.entries(facts).filter(([key, value]) => key !== `step` && !Number.isFinite(value))).toEqual([]);
    });

    it(`says what it does not know as nothing, rather than as a number`, () => {
        const facts = runFacts(pulling, progressView(pulling, 20_000), 20_000);
        expect([facts.downloadedMb, facts.downloadTotalMb, facts.bytesPerSecond]).toEqual([null, null, null]);
        expect(runFacts(startProgress(PULL, 0), progressView(startProgress(PULL, 0), 0), 0).step).toBeNull();
    });
});

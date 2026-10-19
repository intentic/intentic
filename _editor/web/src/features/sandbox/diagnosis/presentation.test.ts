import type { HostReport } from "@intentic/api-contract";
import type { Diagnosis } from "./diagnose";
import { ASLEEP_WAKE_PATIENCE_MS, FIXED_PATIENCE_MS, HOSTED_COLD_PATIENCE_MS, HOSTED_WARM_PATIENCE_MS } from "./diagnose";
import { BUSY_RESTART_AFTER_MS, findingsOf, presentDiagnosis, type PresentationInput, USUAL_MS } from "./presentation";

// What each diagnosis says and offers. The rule under test throughout: at most one thing to press, and nothing to press
// while waiting is still the answer.

// The report fixtures below are written at this instant; `now` sits a minute after it unless a case moves it.
const REPORTED_AT = Date.parse(`2026-09-30T10:00:00.000Z`);

const present = (diagnosis: Diagnosis, over: Partial<PresentationInput> = {}) =>
    presentDiagnosis({ diagnosis, name: `acme`, lane: `own`, owner: true, canRollBack: false, outageMs: 20_000, now: REPORTED_AT + 60_000, ...over });

const report = (over: Partial<HostReport> = {}): HostReport => ({
    source: `agent`,
    machine: `rog`,
    os: `windows`,
    stage: `done`,
    outcome: `needs-you`,
    checks: [
        { id: `docker-app`, label: `Docker Desktop`, state: `ok` },
        { id: `disk`, label: `Free disk space`, state: `warn`, problem: `9 GB free on C:`, remedy: `Free some space.`, fix: `you` },
        { id: `docker`, label: `Docker's engine`, state: `fail`, problem: `It stopped answering.`, remedy: `Restart Docker Desktop.`, fix: `consent` },
    ],
    at: `2026-09-30T10:00:00.000Z`,
    ...over,
});

describe(`a busy sandbox`, () => {
    it(`is a wait with nothing to press`, () => {
        const shown = present({ kind: `busy`, vitals: undefined, longMs: 60_000 });
        expect(shown).toMatchObject({ title: `acme is busy`, waiting: true, tone: `info`, action: undefined, otherActions: [] });
        expect(shown.chain.map((link) => link.state)).toEqual([`ok`, `ok`, `ok`, `working`]);
    });

    it(`names the pressure its netd measured when it is the reason`, () => {
        const vitals = { node: `up` as const, lagMs: 9000, restarts: 0, uptimeS: 60, pressure: { cpu: 12, memory: 88, io: 4 } };
        expect(present({ kind: `busy`, vitals, longMs: 60_000 }).body).toBe(`It's short on memory right now and will catch up by itself.`);
    });

    it(`offers a restart only after a long while, and only among the other options`, () => {
        const own = present({ kind: `busy`, vitals: undefined, longMs: BUSY_RESTART_AFTER_MS });
        expect(own).toMatchObject({ action: undefined, otherActions: [`fix`] });
        expect(own.body).toContain(`5 minutes`);
        expect(present({ kind: `busy`, vitals: undefined, longMs: BUSY_RESTART_AFTER_MS }, { lane: `hosted` }).otherActions).toEqual([`restart-hosted`]);
        expect(present({ kind: `busy`, vitals: undefined, longMs: BUSY_RESTART_AFTER_MS }, { owner: false }).otherActions).toEqual([]);
    });
});

describe(`a sandbox that is down`, () => {
    it(`hands the owner of an own machine the one command once it stops waiting`, () => {
        expect(present({ kind: `not-dialled`, patient: true, lastReport: undefined })).toMatchObject({ waiting: true, action: undefined });
        expect(present({ kind: `not-dialled`, patient: false, lastReport: undefined })).toMatchObject({
            title: `acme isn't connected`,
            waiting: false,
            tone: `warning`,
            action: `fix`,
        });
        expect(present({ kind: `not-dialled`, patient: false, lastReport: undefined }, { owner: false }).action).toBeUndefined();
    });

    it(`says a sleeping sandbox is being woken, and hands the owner the command only once waking has taken too long`, () => {
        const slept = report({ outcome: `healthy`, checks: [], asleep: true });
        expect(present({ kind: `asleep`, report: slept, patient: true })).toMatchObject({ title: `Waking acme`, waiting: true, action: undefined });
        expect(present({ kind: `asleep`, report: slept, patient: true }).body).toContain(`rog put it to sleep`);
        expect(present({ kind: `asleep`, report: slept, patient: false })).toMatchObject({ title: `acme is still asleep`, waiting: false, action: `fix` });
        expect(present({ kind: `asleep`, report: slept, patient: false }, { owner: false }).action).toBeUndefined();
    });

    it(`offers a machine we run a restart, and its rollback where the platform kept one`, () => {
        expect(present({ kind: `hosted-down`, machine: `failed` }, { lane: `hosted` })).toMatchObject({ action: `restart-hosted`, otherActions: [] });
        expect(present({ kind: `hosted-down`, machine: `started` }, { lane: `hosted`, canRollBack: true })).toMatchObject({
            action: `restart-hosted`,
            otherActions: [`rollback-hosted`],
        });
    });

    it(`leads with the rollback for a hosted sandbox that keeps crashing`, () => {
        expect(present({ kind: `crashing`, restarts: 4 }, { lane: `hosted`, canRollBack: true })).toMatchObject({
            action: `rollback-hosted`,
            otherActions: [`restart-hosted`],
        });
        expect(present({ kind: `crashing`, restarts: 4 }).body).toContain(`restarted 4 times`);
    });
});

describe(`the machine's own report`, () => {
    it(`narrates a run in progress in the machine's own words`, () => {
        const working = report({ stage: `fixing`, outcome: undefined, doing: `Starting Docker Desktop` });
        expect(present({ kind: `machine`, report: working, standing: `working` })).toMatchObject({
            title: `rog is fixing acme`,
            body: `Starting Docker Desktop`,
            waiting: true,
            action: undefined,
        });
    });

    it(`lists what the machine left for the reader, the failures first, and hands out the command`, () => {
        const shown = present({ kind: `machine`, report: report(), standing: `needs-you` });
        expect(shown.findings.map((check) => check.id)).toEqual([`docker`, `disk`]);
        expect(shown).toMatchObject({ title: `acme needs a hand on rog`, action: `fix` });
    });

    it(`presses nothing while the command there waits on a yes in its terminal`, () => {
        const asking = report({ stage: `asking`, outcome: undefined, doing: `Restart Docker Desktop?` });
        expect(present({ kind: `machine`, report: asking, standing: `needs-you` })).toMatchObject({
            title: `rog is waiting for you`,
            body: `Restart Docker Desktop?`,
            waiting: true,
            action: undefined,
        });
    });

    it(`keeps only what is not fine`, () => {
        expect(findingsOf(report({ checks: [{ id: `docker`, label: `Docker`, state: `ok` }, { id: `wsl`, label: `WSL`, state: `skip` }] }))).toEqual([]);
    });
});

describe(`this side of the connection`, () => {
    it(`blames nothing on the sandbox when this device is offline, and offers nothing`, () => {
        const shown = present({ kind: `offline` });
        expect(shown).toMatchObject({ title: `You're offline`, waiting: true, action: undefined });
        expect(shown.chain.map((link) => link.state)).toEqual([`down`, `unknown`, `unknown`, `unknown`]);
    });

    it(`points at this network when only the sandbox's address is blocked`, () => {
        expect(present({ kind: `unreachable` }).body).toContain(`*.sbx.intentic.dev`);
    });
});

// Which waits are said the moment they are known, over a workspace that would otherwise show nothing for half a minute:
// only those whose cause is established, never a silence the clock alone could explain.
describe(`a wait said at once`, () => {
    it(`is a sandbox its machine put to sleep, while waking is still the answer`, () => {
        const slept = report({ outcome: `healthy`, checks: [], asleep: true });
        expect(present({ kind: `asleep`, report: slept, patient: true }).sayAtOnce).toBe(true);
        expect(present({ kind: `asleep`, report: slept, patient: false }).sayAtOnce).toBe(false);
    });

    it(`is its machine saying it is starting it`, () => {
        const waking = report({ stage: `fixing`, checks: [], doing: `Waking it` });
        expect(present({ kind: `machine`, report: waking, standing: `working` }).sayAtOnce).toBe(true);
    });

    it(`is a hosted machine the platform says is not running, not one the edge alone calls detached`, () => {
        expect(present({ kind: `waking`, machine: `stopped` }, { lane: `hosted` }).sayAtOnce).toBe(true);
        expect(present({ kind: `waking`, machine: `starting` }, { lane: `hosted` }).sayAtOnce).toBe(true);
        expect(present({ kind: `waking`, machine: undefined }, { lane: `hosted` }).sayAtOnce).toBe(false);
        expect(present({ kind: `waking`, machine: `started` }, { lane: `hosted` }).sayAtOnce).toBe(false);
    });

    it(`is never silence, a busy sandbox, or a cause that waiting cannot repair`, () => {
        expect(present({ kind: `silent`, patient: true }).sayAtOnce).toBe(false);
        expect(present({ kind: `checking` }).sayAtOnce).toBe(false);
        expect(present({ kind: `busy`, vitals: undefined, longMs: 0 }).sayAtOnce).toBe(false);
        expect(present({ kind: `not-dialled`, patient: false, lastReport: undefined }).sayAtOnce).toBe(false);
    });
});

// Every wait that ends by itself says how long it has run, how long it usually takes, and when the screen gives up on
// it, on the same clock the diagnosis gives up on: the time the words promise is the time the way back appears.
describe(`a wait's own clock`, () => {
    it(`times a machine's "fixed" from its report, and gives the sandbox as long to dial in as the diagnosis does`, () => {
        const fixed = report({ outcome: `fixed`, checks: [] });
        const shown = present({ kind: `machine`, report: fixed, standing: `fixed` }, { outageMs: 600_000 });
        expect(shown).toMatchObject({ title: `rog fixed acme`, waiting: true });
        expect(shown.body).toContain(`reconnects by itself`);
        expect(shown.wait).toEqual({ elapsedMs: 60_000, typicalMs: USUAL_MS.fixed, giveUpMs: FIXED_PATIENCE_MS });
    });

    it(`gives a sleeping sandbox about a minute, and the owner a way back once waking has taken too long`, () => {
        const slept = report({ outcome: `healthy`, checks: [], asleep: true });
        expect(present({ kind: `asleep`, report: slept, patient: true }).wait).toEqual({
            elapsedMs: 20_000,
            typicalMs: USUAL_MS.asleep,
            giveUpMs: ASLEEP_WAKE_PATIENCE_MS,
        });
        // Past its patience it is no longer a wait, and says so with a way back rather than a clock.
        expect(present({ kind: `asleep`, report: slept, patient: false }).wait).toBeUndefined();
    });

    it(`expects a hosted machine from the warm pool in seconds and one built to order in minutes`, () => {
        expect(present({ kind: `waking`, machine: `starting` }, { lane: `hosted`, warm: true }).wait).toMatchObject({
            typicalMs: USUAL_MS.wakingWarm,
            giveUpMs: HOSTED_WARM_PATIENCE_MS,
        });
        expect(present({ kind: `waking`, machine: `starting` }, { lane: `hosted`, warm: false }).wait).toMatchObject({
            typicalMs: USUAL_MS.wakingCold,
            giveUpMs: HOSTED_COLD_PATIENCE_MS,
        });
    });

    it(`promises a busy sandbox's owner a restart after a while, and nobody else anything`, () => {
        expect(present({ kind: `busy`, vitals: undefined, longMs: 60_000 }).wait).toEqual({ elapsedMs: 60_000, giveUpMs: BUSY_RESTART_AFTER_MS });
        expect(present({ kind: `busy`, vitals: undefined, longMs: 60_000 }, { owner: false }).wait).toEqual({ elapsedMs: 60_000, giveUpMs: undefined });
    });

    it(`times a wait on this side's network without guessing how long it lasts`, () => {
        expect(present({ kind: `offline` }).wait).toEqual({ elapsedMs: 20_000 });
    });

    it(`has no clock where it waits on the reader, or where waiting is over`, () => {
        const asking = report({ stage: `asking`, outcome: undefined, doing: `Restart Docker Desktop?` });
        expect(present({ kind: `machine`, report: asking, standing: `needs-you` }).wait).toBeUndefined();
        expect(present({ kind: `crashing`, restarts: 4 }).wait).toBeUndefined();
        expect(present({ kind: `silent`, patient: false }).wait).toBeUndefined();
    });
});

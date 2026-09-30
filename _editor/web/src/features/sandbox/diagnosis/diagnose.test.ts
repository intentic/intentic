import type { HostReport } from "@intentic/api-contract";
import type { SandboxVitals } from "@intentic/sandbox-contract";
import {
    CRASH_LOOP_RESTARTS,
    diagnose,
    type DiagnosisInput,
    type Evidence,
    freshReport,
    HOSTED_COLD_PATIENCE_MS,
    HOSTED_WARM_PATIENCE_MS,
    isAlive,
    machineStanding,
    OWN_REDIAL_PATIENCE_MS,
    RESTARTING_PATIENCE_MS,
    SILENT_PATIENCE_MS,
} from "./diagnose";

// Why a sandbox isn't answering, read off what the probes found. The cases the whole module exists for come first: a
// sandbox that is busy is never called down, however long it stays busy.

const OUTAGE_AT = 1_000_000;

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
    at: OUTAGE_AT + 5_000,
    online: true,
    platform: `ok`,
    front: undefined,
    loopback: undefined,
    hosted: undefined,
    ...over,
});

const vitals = (over: Partial<SandboxVitals> = {}): SandboxVitals => ({ node: `up`, lagMs: 12_000, restarts: 0, uptimeS: 3600, pressure: null, ...over });

const input = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
    failure: { kind: `timeout`, message: `silent` },
    outageMs: 20_000,
    outageStartedAt: OUTAGE_AT,
    lane: `own`,
    warm: undefined,
    evidence: evidence(),
    hostReport: undefined,
    now: OUTAGE_AT + 20_000,
    ...over,
});

const report = (over: Partial<HostReport> = {}): HostReport => ({
    source: `agent`,
    machine: `rog`,
    os: `windows`,
    stage: `fixing`,
    doing: `Starting Docker Desktop`,
    checks: [{ id: `docker`, label: `Docker's engine`, state: `fixing`, fix: `auto` }],
    at: new Date(OUTAGE_AT + 10_000).toISOString(),
    ...over,
});

describe(`a sandbox that is alive`, () => {
    it(`is busy, not down, when its front says the daemon is up, at any age of the outage`, () => {
        for (const outageMs of [10_000, 5 * 60_000, 60 * 60_000]) {
            const found = diagnose(input({ outageMs, evidence: evidence({ front: { kind: `vitals`, vitals: vitals() } }) }));
            expect(found).toEqual({ kind: `busy`, vitals: vitals(), longMs: outageMs });
            expect(isAlive(found)).toBe(true);
        }
    });

    it(`is busy when anything behind the edge answered, which an older sandbox without vitals does`, () => {
        expect(diagnose(input({ evidence: evidence({ front: { kind: `answered` } }) }))).toEqual({ kind: `busy`, vitals: undefined, longMs: 20_000 });
    });
});

describe(`a daemon the front is restarting`, () => {
    it(`is restarting, then crashing once it has restarted too often or for too long`, () => {
        const restarting = (restarts: number, outageMs = 20_000) =>
            diagnose(input({ outageMs, evidence: evidence({ front: { kind: `vitals`, vitals: vitals({ node: `restarting`, restarts }) } }) }));
        expect(restarting(CRASH_LOOP_RESTARTS - 1)).toEqual({ kind: `restarting`, restarts: CRASH_LOOP_RESTARTS - 1 });
        expect(restarting(CRASH_LOOP_RESTARTS)).toEqual({ kind: `crashing`, restarts: CRASH_LOOP_RESTARTS });
        expect(restarting(0, RESTARTING_PATIENCE_MS)).toEqual({ kind: `crashing`, restarts: 0 });
    });

    it(`reads an older front's own 503 the same way`, () => {
        expect(diagnose(input({ evidence: evidence({ front: { kind: `restarting` } }) }))).toEqual({ kind: `restarting`, restarts: 0 });
        expect(diagnose(input({ outageMs: RESTARTING_PATIENCE_MS, evidence: evidence({ front: { kind: `restarting` } }) }))).toEqual({ kind: `crashing`, restarts: 0 });
    });
});

describe(`this side of the connection`, () => {
    it(`says this device is offline before anything else`, () => {
        expect(diagnose(input({ evidence: evidence({ online: false, front: { kind: `vitals`, vitals: vitals() } }) }))).toEqual({ kind: `offline` });
    });

    it(`tells a platform that doesn't answer from a network that only blocks the sandbox's address`, () => {
        expect(diagnose(input({ evidence: evidence({ platform: `down`, front: { kind: `unreachable` } }) }))).toEqual({ kind: `platform-down` });
        expect(diagnose(input({ evidence: evidence({ platform: `ok`, front: { kind: `unreachable` } }) }))).toEqual({ kind: `unreachable` });
    });

    it(`is still checking before any probe has settled`, () => {
        expect(diagnose(input({ evidence: undefined }))).toEqual({ kind: `checking` });
    });
});

describe(`an own-machine sandbox that is not dialled in`, () => {
    const noTunnel = evidence({ front: { kind: `edge`, verdict: `no-tunnel` } });

    it(`waits for it to redial, then says it is not connected`, () => {
        expect(diagnose(input({ outageMs: OWN_REDIAL_PATIENCE_MS - 1, evidence: noTunnel }))).toEqual({ kind: `not-dialled`, patient: true, lastReport: undefined });
        expect(diagnose(input({ outageMs: OWN_REDIAL_PATIENCE_MS, evidence: noTunnel }))).toEqual({ kind: `not-dialled`, patient: false, lastReport: undefined });
    });

    it(`defers to its machine's own report about this outage`, () => {
        const working = report();
        expect(diagnose(input({ evidence: noTunnel, hostReport: working }))).toEqual({ kind: `machine`, report: working, standing: `working` });
        const stuck = report({ stage: `done`, outcome: `needs-you`, doing: undefined });
        expect(diagnose(input({ evidence: noTunnel, hostReport: stuck }))).toEqual({ kind: `machine`, report: stuck, standing: `needs-you` });
    });

    it(`does not take the machine's word for "fixed" for ever: the sandbox has to dial in`, () => {
        const fixed = report({ stage: `done`, outcome: `fixed` });
        const at = Date.parse(fixed.at);
        expect(diagnose(input({ evidence: noTunnel, hostReport: fixed, now: at + 60_000 }))).toEqual({ kind: `machine`, report: fixed, standing: `fixed` });
        expect(diagnose(input({ evidence: noTunnel, hostReport: fixed, now: at + 4 * 60_000, outageMs: 5 * 60_000 }))).toEqual({
            kind: `not-dialled`,
            patient: false,
            lastReport: fixed,
        });
    });

    it(`says it runs here and is offline when this computer's loopback answers`, () => {
        expect(diagnose(input({ evidence: evidence({ front: { kind: `edge`, verdict: `no-tunnel` }, loopback: true }) }))).toEqual({ kind: `local-only` });
    });

    it(`reads the edge's verdict from the connection before any probe settles`, () => {
        expect(diagnose(input({ failure: { kind: `detached`, message: `` }, evidence: undefined }))).toEqual({ kind: `not-dialled`, patient: true, lastReport: undefined });
    });
});

describe(`a hosted sandbox that is not dialled in`, () => {
    const hosted = (over: Partial<DiagnosisInput>, machine?: Evidence[`hosted`]) =>
        diagnose(input({ lane: `hosted`, warm: true, evidence: evidence({ front: { kind: `edge`, verdict: `no-tunnel` }, hosted: machine }), ...over }));

    it(`is waking within the patience its pool earns, and down past it`, () => {
        expect(hosted({ outageMs: HOSTED_WARM_PATIENCE_MS - 1 }, `starting`)).toEqual({ kind: `waking`, machine: `starting` });
        expect(hosted({ outageMs: HOSTED_WARM_PATIENCE_MS }, `started`)).toEqual({ kind: `hosted-down`, machine: `started` });
        expect(hosted({ warm: false, outageMs: HOSTED_COLD_PATIENCE_MS - 1 }, `started`)).toEqual({ kind: `waking`, machine: `started` });
    });

    it(`is down at once when its machine failed`, () => {
        expect(hosted({ outageMs: 1_000 }, `failed`)).toEqual({ kind: `hosted-down`, machine: `failed` });
    });

    it(`reads a silent address through the machine's power state`, () => {
        expect(diagnose(input({ lane: `hosted`, warm: true, evidence: evidence({ front: { kind: `silent` }, hosted: `stopped` }) }))).toEqual({
            kind: `waking`,
            machine: `stopped`,
        });
    });
});

describe(`an address that answers nothing`, () => {
    it(`is waited on while a slept computer's tunnel may still be held, then called stuck`, () => {
        const silent = evidence({ front: { kind: `silent` } });
        expect(diagnose(input({ outageMs: SILENT_PATIENCE_MS - 1, evidence: silent }))).toEqual({ kind: `silent`, patient: true });
        expect(diagnose(input({ outageMs: SILENT_PATIENCE_MS, evidence: silent }))).toEqual({ kind: `silent`, patient: false });
    });
});

describe(`which of the machine's reports count`, () => {
    it(`takes only a report about this outage, and not a run that stopped writing`, () => {
        const now = OUTAGE_AT + 60_000;
        expect(freshReport(report({ at: new Date(OUTAGE_AT - 31_000).toISOString() }), OUTAGE_AT, now)).toBeUndefined();
        expect(freshReport(report({ at: new Date(OUTAGE_AT - 29_000).toISOString() }), OUTAGE_AT, now)?.machine).toBe(`rog`);
        expect(freshReport(report(), OUTAGE_AT, OUTAGE_AT + 10_000 + 10 * 60_000 + 1)).toBeUndefined();
        expect(freshReport(report({ stage: `done`, outcome: `needs-you` }), OUTAGE_AT, OUTAGE_AT + 60 * 60_000)?.stage).toBe(`done`);
        expect(freshReport(null, OUTAGE_AT, now)).toBeUndefined();
    });

    it(`reads a question in the terminal and every unfinished outcome as the reader's to act on`, () => {
        expect(machineStanding(report({ stage: `asking` }))).toBe(`needs-you`);
        expect(machineStanding(report({ stage: `checking` }))).toBe(`working`);
        expect(machineStanding(report({ stage: `done`, outcome: `healthy` }))).toBe(`fixed`);
        expect(machineStanding(report({ stage: `done`, outcome: `failed` }))).toBe(`needs-you`);
    });
});

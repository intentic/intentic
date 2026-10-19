import type { HostReport } from "@intentic/api-contract";
import { initialConnection, type ConnectionState } from "../../../client/sandbox/connection";
import { outageDetails } from "./details";

// The raw lines behind "Technical details": what the connection, the probes and the machine said, verbatim. The rule
// under test: each fact appears once and as observed, and nothing is invented where nothing was observed.

const NOW = Date.parse(`2026-10-19T12:00:00.000Z`);

const down: ConnectionState = {
    ...initialConnection,
    phase: `retrying`,
    failure: { kind: `timeout`, message: `no heartbeat for 45s` },
    attempt: 7,
    retryDelayMs: 4_000,
    unavailableSince: NOW - 125_000,
};

const report: HostReport = {
    source: `agent`,
    machine: `rog`,
    os: `windows`,
    stage: `done`,
    outcome: `fixed`,
    checks: [
        { id: `docker`, label: `Docker's engine`, state: `ok` },
        { id: `tunnel`, label: `Tunnel`, state: `fail`, problem: `It never dialled in.`, remedy: `Restart the sandbox.` },
    ],
    at: new Date(NOW - 60_000).toISOString(),
};

describe(`an outage's technical details`, () => {
    it(`say how the connection failed, how often it retried, and when the next try is`, () => {
        const lines = outageDetails({ connection: down, evidence: undefined, report: undefined, diagnosis: undefined, now: NOW });
        expect(lines).toContain(`last failure: timeout: no heartbeat for 45s`);
        expect(lines).toContain(`connection: retrying, attempt 7, next try within 4s`);
        expect(lines.some((line) => line.startsWith(`unreachable since:`) && line.endsWith(`(2m 5s ago)`))).toBe(true);
    });

    it(`list what each probe found, and leave out what was never asked`, () => {
        const lines = outageDetails({
            connection: down,
            evidence: {
                at: NOW - 5_000,
                online: true,
                platform: `ok`,
                netd: { kind: `vitals`, vitals: { node: `restarting`, lagMs: null, restarts: 2, uptimeS: 30, pressure: { cpu: 12, memory: 80, io: 3 } } },
                loopback: undefined,
                hosted: undefined,
            },
            report: undefined,
            diagnosis: { kind: `restarting`, restarts: 2 },
            now: NOW,
        });
        expect(lines).toContain(`sandbox address: netd answered; daemon restarting, 2 restart(s), up 30s, pressure cpu 12% memory 80% io 3%`);
        expect(lines).toContain(`platform: ok`);
        expect(lines).toContain(`diagnosis: restarting`);
        expect(lines.some((line) => line.startsWith(`hosted machine:`) || line.startsWith(`this computer's loopback:`))).toBe(false);
    });

    it(`carry the machine's report check by check, with its problem and remedy`, () => {
        const lines = outageDetails({ connection: down, evidence: undefined, report, diagnosis: undefined, now: NOW });
        expect(lines.some((line) => line.startsWith(`machine report: rog (windows, by agent) at`))).toBe(true);
        expect(lines).toContain(`  stage: done, fixed`);
        expect(lines).toContain(`  [ok  ] Docker's engine`);
        expect(lines).toContain(`  [FAIL] Tunnel`);
        expect(lines).toContain(`         → Restart the sandbox.`);
    });

    it(`say whether a diagnosis is still waiting or has given up`, () => {
        const waiting = outageDetails({ connection: down, evidence: undefined, report: undefined, diagnosis: { kind: `silent`, patient: true }, now: NOW });
        const gaveUp = outageDetails({ connection: down, evidence: undefined, report: undefined, diagnosis: { kind: `silent`, patient: false }, now: NOW });
        expect(waiting.at(-1)).toBe(`diagnosis: silent (waiting)`);
        expect(gaveUp.at(-1)).toBe(`diagnosis: silent (gave up waiting)`);
    });
});

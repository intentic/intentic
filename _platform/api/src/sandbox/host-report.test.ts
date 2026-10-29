import { createHmac } from "node:crypto";
import { type HostReport, type HostReportInput, HostReportSchema, SLEEP_CHECK_FRESH_MS } from "@intentic/api-contract";
import {
    HOST_REPORT_INTERVAL_MS,
    HOST_REPORTERS,
    hostReportKey,
    hostReportOf,
    hostReportsOf,
    reporterOf,
    skipsWrite,
    sleepOf,
    WAKE_REQUEST_TTL_MS,
    wakeIsLive,
    withHostReport,
} from "./host-report.js";

const NOW = Date.parse(`2026-09-30T12:00:00.000Z`);

const checking: HostReportInput = { source: `command`, machine: `rog`, os: `wsl`, stage: `checking`, checks: [] };

// The stored report, `ageMs` older than NOW.
const storedAged = (ageMs: number, report: HostReportInput = checking): HostReport => ({ ...report, at: new Date(NOW - ageMs).toISOString() });

describe(`hostReportKey`, () => {
    // `ic` computes the same bytes on the machine, so the label is spelled out here rather than imported.
    it(`is lowercase hex HMAC-SHA256 over the label, keyed with the connect token`, () => {
        expect(hostReportKey(`tok`)).toBe(createHmac(`sha256`, `tok`).update(`intentic/host-report/v1`).digest(`hex`));
        expect(hostReportKey(`tok`)).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe(`skipsWrite`, () => {
    it(`skips the same stage and outcome up to the last millisecond of the interval`, () => {
        expect(skipsWrite(storedAged(0), checking, NOW)).toBe(true);
        expect(skipsWrite(storedAged(HOST_REPORT_INTERVAL_MS - 1), checking, NOW)).toBe(true);
    });

    it(`writes once the interval has passed`, () => {
        expect(HOST_REPORT_INTERVAL_MS).toBe(2000);
        expect(skipsWrite(storedAged(HOST_REPORT_INTERVAL_MS), checking, NOW)).toBe(false);
    });

    it(`writes a moved stage or outcome however recent the stored one`, () => {
        expect(skipsWrite(storedAged(0), { ...checking, stage: `fixing` }, NOW)).toBe(false);
        const done: HostReportInput = { ...checking, stage: `done`, outcome: `fixed` };
        expect(skipsWrite(storedAged(0, done), { ...done, outcome: `failed` }, NOW)).toBe(false);
        // An outcome appearing is a move too: absent and present are two answers.
        expect(skipsWrite(storedAged(0, { ...checking, stage: `done` }), done, NOW)).toBe(false);
    });

    it(`writes a sleep reported right after the same healthy verdict`, () => {
        const healthy: HostReportInput = { ...checking, stage: `done`, outcome: `healthy` };
        expect(skipsWrite(storedAged(0, healthy), { ...healthy, asleep: true }, NOW)).toBe(false);
        expect(skipsWrite(storedAged(0, { ...healthy, asleep: true }), healthy, NOW)).toBe(false);
    });

    it(`writes when there is nothing stored, and when the stored one is from the future`, () => {
        expect(skipsWrite(null, checking, NOW)).toBe(false);
        expect(skipsWrite(storedAged(-1), checking, NOW)).toBe(false);
    });
});

describe(`hostReportOf`, () => {
    it(`answers a stored report as the contract states it`, () => {
        const stored = { ...checking, at: `2026-09-30T12:00:00.000Z` };
        expect(hostReportOf(stored)).toEqual(HostReportSchema.parse(stored));
    });

    it(`answers null for a row with none, and for a stored one that no longer parses`, () => {
        expect(hostReportOf(null)).toBeNull();
        expect(hostReportOf(undefined)).toBeNull();
        expect(hostReportOf({ stage: `checking`, at: `2026-09-30T12:00:00.000Z` })).toBeNull();
        expect(hostReportOf(`not a report`)).toBeNull();
    });
});

/* ONE SLOT PER REPORTER (2026-10-05): the Windows agent and the WSL agent on one PC used to overwrite each other. */
describe(`reports per reporter`, () => {
    const windows: HostReport = {
        source: `agent`,
        machine: `ROG`,
        os: `windows`,
        stage: `done`,
        outcome: `healthy`,
        checks: [],
        at: `2026-10-05T12:00:00.000Z`,
    };
    const wsl: HostReport = {
        source: `agent`,
        machine: `rog`,
        os: `wsl`,
        env: `Ubuntu`,
        stage: `done`,
        outcome: `fixed`,
        checks: [],
        at: `2026-10-05T12:01:00.000Z`,
    };

    it(`keeps the newest report of each machine and environment, and answers the newest of them first`, () => {
        const both = withHostReport(withHostReport(null, windows), wsl);
        expect(hostReportsOf(both)).toEqual([wsl, windows]);
        expect(hostReportOf(both)).toEqual(wsl);
        // The same reporter again replaces its own slot and nobody else's.
        const later = { ...windows, outcome: `needs-you` as const, at: `2026-10-05T12:02:00.000Z` };
        expect(hostReportsOf(withHostReport(both, later))).toEqual([later, wsl]);
    });

    it(`tells the reporters apart by OS and environment, not by how the machine's name is cased`, () => {
        expect(reporterOf(windows)).not.toBe(reporterOf(wsl));
        expect(reporterOf({ ...windows, machine: `rog` })).toBe(reporterOf(windows));
        expect(reporterOf({ ...wsl, env: `Debian` })).not.toBe(reporterOf(wsl));
    });

    it(`keeps no more than ${HOST_REPORTERS} reporters, dropping the one silent longest`, () => {
        let stored: unknown = null;
        for (const [index, machine] of [`a`, `b`, `c`, `d`].entries()) {
            stored = withHostReport(stored, { ...windows, machine, at: `2026-10-05T12:0${index}:00.000Z` });
        }
        expect(hostReportsOf(stored).map((report) => report.machine)).toEqual([`d`, `c`, `b`]);
    });

    it(`reads a row written before reporters had slots as its one reporter, and keeps it beside the next`, () => {
        expect(hostReportsOf(windows)).toEqual([windows]);
        expect(hostReportsOf(withHostReport(windows, wsl))).toEqual([wsl, windows]);
    });

    it(`carries the upkeep counts an ic with an upkeep pass sends`, () => {
        const upkeep = { found: 4, fixed: 3, skipped: 1, kinds: { pairing: 2, volume: 2 } };
        expect(hostReportsOf(withHostReport(null, { ...windows, upkeep }))[0]?.upkeep).toEqual(upkeep);
    });
});

describe(`wakeIsLive`, () => {
    it(`holds a request for its lifetime and no longer, and none at all for no stamp`, () => {
        expect(wakeIsLive(new Date(NOW - WAKE_REQUEST_TTL_MS), NOW)).toBe(true);
        expect(wakeIsLive(new Date(NOW - WAKE_REQUEST_TTL_MS - 1), NOW)).toBe(false);
        expect(wakeIsLive(null, NOW)).toBe(false);
    });
});

// Every view of the account's other sandboxes said "not answering" about one that had only gone to sleep, since the
// report saying so was the owner's alone and nothing said whether its machine could still start it (2026-10-29).
describe(`sleepOf`, () => {
    const done: HostReportInput = { ...checking, stage: `done`, outcome: `healthy` };
    const ago = (ms: number): Date => new Date(NOW - ms);
    const asleepAt = (ms: number): HostReport => storedAged(ms, { ...done, asleep: true });

    it(`is asleep and wakeable on the report that put it to sleep, before any ask has come`, () => {
        expect(sleepOf({ reports: [asleepAt(10_000)], sleepCheckedAt: null, lastSeenAt: ago(60 * 60_000) }, NOW)).toEqual({
            heardAt: ago(10_000).toISOString(),
            wakeable: true,
        });
    });

    it(`stays wakeable while its machine keeps asking, however long ago it went to sleep`, () => {
        const sleep = sleepOf({ reports: [asleepAt(8 * 60 * 60_000)], sleepCheckedAt: ago(30_000), lastSeenAt: ago(9 * 60 * 60_000) }, NOW);
        expect(sleep).toEqual({ heardAt: ago(30_000).toISOString(), wakeable: true });
    });

    it(`is not wakeable once its machine has not been heard for longer than the window`, () => {
        const off = sleepOf({ reports: [asleepAt(60 * 60_000)], sleepCheckedAt: ago(SLEEP_CHECK_FRESH_MS + 1), lastSeenAt: null }, NOW);
        expect(off).toEqual({ heardAt: ago(SLEEP_CHECK_FRESH_MS + 1).toISOString(), wakeable: false });
        expect(sleepOf({ reports: [asleepAt(SLEEP_CHECK_FRESH_MS)], sleepCheckedAt: null, lastSeenAt: null }, NOW)?.wakeable).toBe(true);
    });

    it(`is asleep on its machine's asks alone when the report saying so never landed`, () => {
        expect(sleepOf({ reports: [storedAged(20 * 60_000, done)], sleepCheckedAt: ago(5_000), lastSeenAt: ago(30 * 60_000) }, NOW)).toEqual({
            heardAt: ago(5_000).toISOString(),
            wakeable: true,
        });
        expect(sleepOf({ reports: [], sleepCheckedAt: ago(5_000), lastSeenAt: null }, NOW)?.wakeable).toBe(true);
    });

    it(`is awake once a report or an announce comes after the last word of the sleep`, () => {
        // The wake's own report: the keeper starting it.
        expect(sleepOf({ reports: [storedAged(2_000, { ...checking, stage: `fixing` }), asleepAt(60_000)], sleepCheckedAt: ago(30_000), lastSeenAt: null }, NOW)).toBeNull();
        // Started some other way: the daemon announced.
        expect(sleepOf({ reports: [asleepAt(60_000)], sleepCheckedAt: ago(30_000), lastSeenAt: ago(1_000) }, NOW)).toBeNull();
    });

    it(`is awake with nothing saying it sleeps`, () => {
        expect(sleepOf({ reports: [], sleepCheckedAt: null, lastSeenAt: ago(1_000) }, NOW)).toBeNull();
        expect(sleepOf({ reports: [storedAged(1_000, done)], sleepCheckedAt: null, lastSeenAt: null }, NOW)).toBeNull();
    });
});

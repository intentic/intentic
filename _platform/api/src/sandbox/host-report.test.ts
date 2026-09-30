import { createHmac } from "node:crypto";
import { type HostReport, type HostReportInput, HostReportSchema } from "@intentic/api-contract";
import { HOST_REPORT_INTERVAL_MS, hostReportKey, hostReportOf, skipsWrite } from "./host-report.js";

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

import type { AccountUsage } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { formatAge, usageDetail, usagePercent, usageWindowLabel } from "./usageStatus";

const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({ status: `allowed`, utilization: 42.4, measuredAt: 0, ...over });

describe(`usageWindowLabel`, () => {
    it(`names the two windows the SDK reports and stays generic otherwise`, () => {
        expect(usageWindowLabel(`five_hour`)).toBe(`5-hour limit`);
        expect(usageWindowLabel(`seven_day`)).toBe(`Weekly limit`);
        // seven_day_opus / seven_day_sonnet are per-model weekly buckets — still "weekly" to a reader.
        expect(usageWindowLabel(`seven_day_opus`)).toBe(`Weekly limit`);
        expect(usageWindowLabel(undefined)).toBe(`Usage`);
    });
});

describe(`usagePercent`, () => {
    it(`rounds a reported utilization`, () => {
        expect(usagePercent(usage({ utilization: 42.4 }))).toBe(42);
        expect(usagePercent(usage({ utilization: 0 }))).toBe(0);
    });

    it(`is undefined when nothing was measured, so a row reads unknown rather than 0%`, () => {
        expect(usagePercent(undefined)).toBeUndefined();
        expect(usagePercent(usage({ utilization: undefined }))).toBeUndefined();
    });
});

describe(`formatAge`, () => {
    const now = 1_000_000_000_000;
    it(`coarsens the snapshot's age so a persisted reading never reads as live`, () => {
        expect(formatAge(now - 30_000, now)).toBe(`just now`);
        expect(formatAge(now - 15 * 60_000, now)).toBe(`15m ago`);
        expect(formatAge(now - 3 * 3_600_000, now)).toBe(`3h ago`);
        expect(formatAge(now - 2 * 86_400_000, now)).toBe(`2d ago`);
    });
});

describe(`usageDetail`, () => {
    it(`names the window, the spend, the reset, and how stale the reading is`, () => {
        const detail = usageDetail(usage({ rateLimitType: `five_hour`, utilization: 87, resetsAt: 1_800_000, measuredAt: Date.now() }));
        expect(detail).toContain(`5-hour limit`);
        expect(detail).toContain(`87% used`);
        expect(detail).toContain(`resets `);
        expect(detail).toContain(`measured just now`);
    });

    it(`omits the reset when the snapshot carries no reset instant`, () => {
        expect(usageDetail(usage({ resetsAt: undefined, measuredAt: Date.now() }))).not.toContain(`resets`);
    });
});

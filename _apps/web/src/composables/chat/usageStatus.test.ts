import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import {
    bindingWindow,
    formatAge,
    formatReset,
    formatUtilization,
    formatWait,
    isStale,
    orderedWindows,
    usageDetail,
    usagePercent,
    usageWindowLabel,
} from "./usageStatus";

const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({ kind: `seven_day`, utilization: 42.4, ...over });
const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({ windows: [window()], measuredAt: 0, ...over });

describe(`usageWindowLabel`, () => {
    it(`keeps every weekly pool distinguishable — folding them is the bug it exists to prevent`, () => {
        expect(usageWindowLabel(window({ kind: `five_hour` }))).toBe(`5-hour session`);
        expect(usageWindowLabel(window({ kind: `seven_day` }))).toBe(`Weekly · all models`);
        expect(usageWindowLabel(window({ kind: `seven_day_opus` }))).toBe(`Weekly · Opus`);
        expect(usageWindowLabel(window({ kind: `seven_day_oauth_apps` }))).toBe(`Weekly · third-party apps`);
    });

    it(`prefers the provider's own name for a per-model pool`, () => {
        expect(usageWindowLabel(window({ kind: `model:Fable`, label: `Fable` }))).toBe(`Weekly · Fable`);
    });

    it(`shows an unrecognised pool under its raw key rather than folding it into a neighbour`, () => {
        expect(usageWindowLabel(window({ kind: `thirty_day_experimental` }))).toBe(`thirty_day_experimental`);
    });
});

describe(`orderedWindows`, () => {
    it(`puts the soonest-biting pool first and the broad weekly one ahead of the per-model ones`, () => {
        const ordered = orderedWindows(
            usage({
                windows: [
                    window({ kind: `model:Fable`, label: `Fable` }),
                    window({ kind: `seven_day_opus` }),
                    window({ kind: `seven_day` }),
                    window({ kind: `five_hour` }),
                ],
            }),
        );
        expect(ordered.map((entry) => entry.kind)).toEqual([`five_hour`, `seven_day`, `seven_day_opus`, `model:Fable`]);
    });
});

describe(`bindingWindow`, () => {
    it(`is the FULLEST pool — the account is as constrained as its tightest allowance`, () => {
        const picked = bindingWindow(
            usage({ windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 98 })] }),
        );
        expect(picked?.kind).toBe(`seven_day`);
    });

    it(`is undefined when no pool was reported, so a row reads unknown rather than 0%`, () => {
        expect(bindingWindow(undefined)).toBeUndefined();
        expect(bindingWindow(usage({ windows: [] }))).toBeUndefined();
    });
});

describe(`usagePercent`, () => {
    it(`rounds the binding pool's utilization`, () => {
        expect(usagePercent(usage({ windows: [window({ utilization: 42.4 })] }))).toBe(42);
        expect(usagePercent(usage({ windows: [window({ utilization: 0 })] }))).toBe(0);
    });

    it(`is undefined when nothing was measured`, () => {
        expect(usagePercent(undefined)).toBeUndefined();
        expect(usagePercent(usage({ windows: [] }))).toBeUndefined();
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

describe(`isStale / formatUtilization`, () => {
    const now = 1_000_000_000_000;
    it(`turns an overtaken reading into a floor rather than a figure`, () => {
        expect(isStale(usage({ measuredAt: now - 60_000 }), now)).toBe(false);
        expect(isStale(usage({ measuredAt: now - 8 * 3_600_000 }), now)).toBe(true);
        expect(formatUtilization(98, false)).toBe(`98%`);
        expect(formatUtilization(98, true)).toBe(`≥98%`);
    });
});

describe(`usageDetail`, () => {
    it(`lists EVERY pool, because which one is binding is what a single number can't say`, () => {
        const detail = usageDetail(
            usage({
                windows: [window({ kind: `five_hour`, utilization: 12 }), window({ kind: `seven_day`, utilization: 98 })],
                measuredAt: Date.now(),
            }),
        );
        expect(detail).toBe(`5-hour session 12% · Weekly · all models 98% · measured just now`);
    });

    it(`names each pool's reset beside its figure — "wait 20 minutes" and "wait until Thursday" are different answers`, () => {
        const resetsAt = 1_700_000_000;
        const detail = usageDetail(
            usage({
                windows: [window({ kind: `five_hour`, utilization: 91, resetsAt }), window({ kind: `seven_day`, utilization: 40 })],
                measuredAt: Date.now(),
            }),
        );
        // formatReset renders in the runner's locale/zone, so the expectation reuses it and asserts placement.
        expect(detail).toBe(`5-hour session 91% (resets ${formatReset(resetsAt)}) · Weekly · all models 40% · measured just now`);
    });

    it(`marks every figure as a floor once the reading is old enough to have been overtaken elsewhere`, () => {
        const detail = usageDetail(usage({ windows: [window({ kind: `seven_day`, utilization: 1 })], measuredAt: Date.now() - 8 * 3_600_000 }));
        expect(detail).toBe(`Weekly · all models ≥1% · measured 8h ago`);
    });
});

/* The outage retry's wait, which is the one instant in the app a wall-clock time would misreport: it is seconds
 * to minutes out, not hours, and it grows with every attempt. Coarse on purpose — the daemon's schedule carries
 * jitter and polls on its own cadence, so second-accurate wording here would promise precision it cannot keep. */
describe(`formatWait`, () => {
    const now = 1_000_000_000;

    it(`reads as seconds for a short wait, rounded so it never looks second-accurate`, () => {
        expect(formatWait(now / 1000 + 30, now)).toBe(`about 30s`);
        expect(formatWait(now / 1000 + 32, now)).toBe(`about 30s`);
    });

    it(`switches to minutes once seconds stop being useful`, () => {
        expect(formatWait(now / 1000 + 300, now)).toBe(`about 5 min`);
        expect(formatWait(now / 1000 + 1_200, now)).toBe(`about 20 min`);
    });

    it(`never counts backwards past zero — a due-but-unfired retry reads as imminent, not overdue`, () => {
        expect(formatWait(now / 1000 - 60, now)).toBe(`about 5s`);
    });
});

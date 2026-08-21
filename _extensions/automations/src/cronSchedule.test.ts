import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronOf, defaultSchedule, nextIn, parseCron, type ScheduleState, scheduleLabel, since } from "./cronSchedule";

const schedule = (overrides: Partial<ScheduleState>): ScheduleState => ({ ...defaultSchedule(), ...overrides });

describe(`cronOf`, () => {
    it(`composes every frequency`, () => {
        expect(cronOf(schedule({ freq: `minutes`, everyMinutes: 5 }))).toBe(`*/5 * * * *`);
        expect(cronOf(schedule({ freq: `minutes`, everyMinutes: 1 }))).toBe(`*/1 * * * *`);
        expect(cronOf(schedule({ freq: `hourly` }))).toBe(`0 * * * *`);
        expect(cronOf(schedule({ freq: `daily`, time: `09:05` }))).toBe(`5 9 * * *`);
        expect(cronOf(schedule({ freq: `weekly`, days: [5, 1, 3] }))).toBe(`0 9 * * 1,3,5`);
        expect(cronOf(schedule({ freq: `monthly`, dayOfMonth: 1 }))).toBe(`0 9 1 * *`);
        expect(cronOf(schedule({ freq: `custom`, cron: ` */7 * * * * ` }))).toBe(`*/7 * * * *`);
    });

    it(`returns undefined for unsubmittable states`, () => {
        expect(cronOf(schedule({ freq: `weekly`, days: [] }))).toBeUndefined();
        expect(cronOf(schedule({ freq: `custom`, cron: `` }))).toBeUndefined();
        expect(cronOf(schedule({ freq: `daily`, time: `` }))).toBeUndefined();
        expect(cronOf(schedule({ freq: `minutes`, everyMinutes: Number.NaN }))).toBeUndefined();
        expect(cronOf(schedule({ freq: `minutes`, everyMinutes: 60 }))).toBeUndefined();
        expect(cronOf(schedule({ freq: `monthly`, dayOfMonth: 32 }))).toBeUndefined();
    });

    it(`roundtrips through parseCron`, () => {
        const states = [
            schedule({ freq: `minutes`, everyMinutes: 5 }),
            schedule({ freq: `hourly` }),
            schedule({ freq: `daily`, time: `09:05` }),
            schedule({ freq: `weekly`, days: [0, 1, 2, 3, 4, 5, 6] }),
            schedule({ freq: `weekly`, days: [1, 3, 5] }),
            schedule({ freq: `monthly`, dayOfMonth: 22, time: `08:30` }),
        ];
        for (const state of states) {
            const cron = cronOf(state);
            expect(cron).toBeDefined();
            expect(parseCron(cron ?? ``)).toEqual(state);
        }
    });
});

describe(`parseCron`, () => {
    it(`expands dow ranges and normalizes 7 to Sunday`, () => {
        expect(parseCron(`0 9 * * 1-5`).days).toEqual([1, 2, 3, 4, 5]);
        expect(parseCron(`0 9 * * 1-3,5`).days).toEqual([1, 2, 3, 5]);
        expect(parseCron(`0 9 * * 7`).days).toEqual([0]);
        expect(parseCron(`* * * * *`)).toEqual(schedule({ freq: `minutes`, everyMinutes: 1 }));
    });

    it(`falls back to custom for shapes the builder cannot produce`, () => {
        for (const cron of [`0 9 * 2 *`, `0 9 1 * 1`, `*/15 9 * * *`, `0 9,17 * * *`, `0 25 * * *`, `30 * * * *`, `garbage`, `0 9 * * MON`]) {
            expect(parseCron(cron)).toEqual(schedule({ freq: `custom`, cron }));
        }
    });
});

describe(`scheduleLabel`, () => {
    it(`labels every recognized shape`, () => {
        expect(scheduleLabel(`*/5 * * * *`)).toBe(`Every 5 min`);
        expect(scheduleLabel(`0 * * * *`)).toBe(`Hourly`);
        expect(scheduleLabel(`0 9 * * *`)).toBe(`Daily 09:00`);
        expect(scheduleLabel(`0 9 * * 1-5`)).toBe(`Weekdays 09:00`);
        expect(scheduleLabel(`0 9 * * 0,1,2,3,4,5,6`)).toBe(`Every day 09:00`);
        expect(scheduleLabel(`0 9 * * 1,3,5`)).toBe(`Mon, Wed, Fri 09:00`);
        expect(scheduleLabel(`0 9 * * 0,6`)).toBe(`Sat, Sun 09:00`);
        expect(scheduleLabel(`0 9 1 * *`)).toBe(`Monthly 1st 09:00`);
        expect(scheduleLabel(`30 8 22 * *`)).toBe(`Monthly 22nd 08:30`);
    });

    it(`passes unrecognized crons through raw`, () => {
        expect(scheduleLabel(`7 3 * 2 *`)).toBe(`7 3 * 2 *`);
    });
});

describe(`since / nextIn`, () => {
    const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
    const MINUTE = 60_000;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it(`steps a past run through the minute/hour/day tiers`, () => {
        expect(since(NOW)).toBe(`just now`);
        expect(since(NOW - 5 * MINUTE)).toBe(`5m ago`);
        expect(since(NOW - 59 * MINUTE)).toBe(`59m ago`);
        expect(since(NOW - 3 * 60 * MINUTE)).toBe(`3h ago`);
        expect(since(NOW - 50 * 60 * MINUTE)).toBe(`2d ago`);
    });

    it(`counts down to the next fire, and reads a slipped one as due`, () => {
        expect(nextIn(NOW + 5 * MINUTE)).toBe(`in 5m`);
        expect(nextIn(NOW + 3 * 60 * MINUTE)).toBe(`in 3h`);
        expect(nextIn(NOW + 50 * 60 * MINUTE)).toBe(`in 2d`);
        // The scheduler polls, so a nextRun a moment behind the clock is normal, not a missed run.
        expect(nextIn(NOW)).toBe(`due`);
        expect(nextIn(NOW - 5 * MINUTE)).toBe(`due`);
    });
});

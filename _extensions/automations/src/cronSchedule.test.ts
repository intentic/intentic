import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZoneSchema } from "@intentic/sandbox-contract/time";
import { cronOf, defaultSchedule, nextIn, parseCron, type ScheduleState, scheduleLabel, scheduleTriggerLabel, since } from "./cronSchedule";

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
            // Five whitespace-separated fields, which is what a cron expression IS. The round-trip below would
            // also catch a malformed one, but only after parseCron had already decided what to do with it.
            expect(cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
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

// A reader on the same clock as the rule, which is the common case and the one that must stay unqualified.
const HOME = ZoneSchema.parse(`Europe/Warsaw`);
const AWAY = ZoneSchema.parse(`America/New_York`);

describe(`scheduleLabel`, () => {
    it(`labels every recognized shape`, () => {
        expect(scheduleLabel(`*/5 * * * *`, HOME, HOME)).toBe(`Every 5 min`);
        expect(scheduleLabel(`0 * * * *`, HOME, HOME)).toBe(`Hourly`);
        expect(scheduleLabel(`0 9 * * *`, HOME, HOME)).toBe(`Daily 09:00`);
        expect(scheduleLabel(`0 9 * * 1-5`, HOME, HOME)).toBe(`Weekdays 09:00`);
        expect(scheduleLabel(`0 9 * * 0,1,2,3,4,5,6`, HOME, HOME)).toBe(`Every day 09:00`);
        expect(scheduleLabel(`0 9 * * 1,3,5`, HOME, HOME)).toBe(`Mon, Wed, Fri 09:00`);
        expect(scheduleLabel(`0 9 * * 0,6`, HOME, HOME)).toBe(`Sat, Sun 09:00`);
        expect(scheduleLabel(`0 9 1 * *`, HOME, HOME)).toBe(`Monthly 1st 09:00`);
        expect(scheduleLabel(`30 8 22 * *`, HOME, HOME)).toBe(`Monthly 22nd 08:30`);
    });

    /* THE ONE THAT MATTERS: "Daily 20:43" said nothing about whose 20:43, and the answer was the container's. */
    it(`names the rule's zone to a reader who is not on that clock`, () => {
        expect(scheduleLabel(`43 20 * * *`, AWAY, HOME)).toBe(`Daily 20:43 Europe/Warsaw`);
        expect(scheduleLabel(`0 9 1 * *`, AWAY, HOME)).toBe(`Monthly 1st 09:00 Europe/Warsaw`);
        expect(scheduleLabel(`0 9 * * 1-5`, AWAY, HOME)).toBe(`Weekdays 09:00 Europe/Warsaw`);
    });

    it(`stays quiet for a reader already on the rule's clock`, () => {
        expect(scheduleLabel(`43 20 * * *`, HOME, HOME)).toBe(`Daily 20:43`);
    });

    /* An interval means the same thing on every clock, so qualifying it would be false precision. */
    it(`never qualifies a shape that names no hour`, () => {
        expect(scheduleLabel(`*/5 * * * *`, AWAY, HOME)).toBe(`Every 5 min`);
        expect(scheduleLabel(`0 * * * *`, AWAY, HOME)).toBe(`Hourly`);
    });

    it(`carries a sessions bar on the phrase, and only then`, () => {
        expect(scheduleTriggerLabel({ cron: `0 5 * * *`, afterSessions: 30 }, HOME, HOME)).toBe(`Daily 05:00 · after 30 sessions`);
        expect(scheduleTriggerLabel({ cron: `0 5 * * *` }, HOME, HOME)).toBe(`Daily 05:00`);
    });

    it(`takes the trigger's own zone over the sandbox's, and the sandbox's when it has none`, () => {
        expect(scheduleTriggerLabel({ cron: `0 5 * * *`, tz: `Asia/Tokyo` }, HOME, HOME)).toBe(`Daily 05:00 Asia/Tokyo`);
        expect(scheduleTriggerLabel({ cron: `0 5 * * *` }, AWAY, HOME)).toBe(`Daily 05:00 Europe/Warsaw`);
    });

    it(`passes unrecognized crons through raw`, () => {
        expect(scheduleLabel(`7 3 * 2 *`, HOME, HOME)).toBe(`7 3 * 2 *`);
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

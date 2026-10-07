import type { AutomationRun, AutomationSummary, Trigger } from "@intentic/sandbox-contract";
import { localZone, ZoneSchema } from "@intentic/sandbox-contract/time";
import { addDays, calendarWeek, instantAt, layoutDay, minuteOfDay, weekStartOf } from "./calendarModel";

// Every instant here is built on the reader's own clock, and the sandbox zone is the reader's too, so a cron's "03:00"
// lands at minute 180 whatever zone the test machine runs in.
const zone = localZone();
const local = (day: number, hour: number, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime();
// Wednesday 7 October 2026, noon: the week is Monday 5th to Sunday 11th.
const now = local(7, 12);
const week = weekStartOf(now);

const automation = (id: string, trigger: Trigger, overrides: Partial<AutomationSummary> = {}): AutomationSummary => ({
    id,
    trigger,
    prompt: `do it`,
    models: [{ provider: `claude`, model: `claude-sonnet-5` }],
    enabled: true,
    runs: [],
    ...overrides,
});
const run = (at: number, outcome: AutomationRun[`outcome`] = `completed`): AutomationRun => ({ at, outcome });

describe(`the reader's week`, () => {
    it(`starts on Monday at local midnight`, () => {
        expect(week).toBe(local(5, 0));
        expect(weekStartOf(local(11, 23, 59))).toBe(local(5, 0));
        expect(weekStartOf(local(12, 0))).toBe(local(12, 0));
        expect(addDays(week, 7)).toBe(local(12, 0));
    });

    it(`turns a slot back into an instant`, () => {
        expect(instantAt(local(8, 0), 14 * 60 + 30)).toBe(local(8, 14, 30));
        expect(minuteOfDay(local(8, 14, 30))).toBe(870);
    });
});

describe(`calendarWeek`, () => {
    it(`plots a daily schedule ahead of now, and its ledger behind`, () => {
        const nightly = automation(`nightly`, { kind: `schedule`, cron: `0 3 * * *` }, { runs: [run(local(7, 3), `error`), run(local(6, 3, 1))] });
        const { entries, lane } = calendarWeek([nightly], week, now, zone);
        expect(lane).toEqual([]);
        expect(entries.map((entry) => [entry.day, entry.minute, entry.state])).toEqual([
            [1, 181, `completed`],
            [2, 180, `error`],
            [3, 180, `upcoming`],
            [4, 180, `upcoming`],
            [5, 180, `upcoming`],
            [6, 180, `upcoming`],
        ]);
        // The past slot carries the run it stands for, so the popover can open its transcript.
        expect(entries[1]?.run?.outcome).toBe(`error`);
    });

    it(`draws a switched-off schedule as paused rather than leaving it out`, () => {
        const off = automation(`off`, { kind: `schedule`, cron: `30 9 * * 1` }, { enabled: false });
        const next = addDays(week, 7);
        expect(calendarWeek([off], next, now, zone).entries.map((entry) => [entry.day, entry.minute, entry.state])).toEqual([[0, 570, `paused`]]);
    });

    it(`keeps a few-times-a-day rule as moments`, () => {
        const thrice = automation(`thrice`, { kind: `schedule`, cron: `41 */8 * * *` });
        const { entries, lane } = calendarWeek([thrice], week, now, zone);
        expect(lane).toEqual([]);
        // Wednesday's 16:41, then three a day to Sunday.
        expect(entries).toHaveLength(1 + 4 * 3);
        expect(entries[0]?.minute).toBe(16 * 60 + 41);
    });

    it(`moves a cadence into the lane, from today, one bar per unbroken stretch`, () => {
        const ping = automation(`ping`, { kind: `schedule`, cron: `*/5 * * * *` }, { runs: [run(now - 60_000)] });
        const office = automation(`office`, { kind: `schedule`, cron: `*/15 9-17 * * 1,2,4,5` });
        const { entries, lane } = calendarWeek([ping, office], week, now, zone);
        // No slot at all, the ledger's included: twenty runs of a five-minute rule is the last hour and a half.
        expect(entries).toEqual([]);
        expect(lane.map((bar) => [bar.automation.id, bar.from, bar.to])).toEqual([
            [`ping`, 2, 6],
            [`office`, 3, 4],
        ]);
        // A week ahead starts on Monday, and Wednesday's gap splits it.
        const ahead = calendarWeek([office], addDays(week, 7), now, zone).lane.map((bar) => [bar.from, bar.to]);
        expect(ahead).toEqual([
            [0, 1],
            [3, 4],
        ]);
        // A week behind has nothing coming.
        expect(calendarWeek([ping], addDays(week, -7), now, zone).lane).toEqual([]);
    });

    it(`places a one-time wake at its moment, paused when off, and as its run once spent`, () => {
        const soon = automation(`soon`, { kind: `once`, at: local(9, 15) });
        const held = automation(`held`, { kind: `once`, at: local(10, 8) }, { enabled: false });
        const spent = automation(`spent`, { kind: `once`, at: local(6, 10) }, { enabled: false, runs: [run(local(6, 10))] });
        const { entries } = calendarWeek([soon, held, spent], week, now, zone);
        expect(entries.map((entry) => [entry.automation.id, entry.day, entry.state])).toEqual([
            [`spent`, 1, `completed`],
            [`soon`, 4, `upcoming`],
            [`held`, 5, `paused`],
        ]);
    });

    it(`names what no clock drives instead of placing it`, () => {
        const listener = automation(`discord`, { kind: `listener`, provider: `discord` }, { runs: [run(local(7, 9))] });
        const hook = automation(`hook`, { kind: `event` });
        const result = calendarWeek([listener, hook], week, now, zone);
        expect(result.entries).toEqual([]);
        expect(result.elsewhere.map((item) => item.id)).toEqual([`discord`, `hook`]);
    });

    it(`reads a cron in its own zone, not the reader's`, () => {
        // Whatever the reader's clock, 03:00 in Tokyo is one instant; the slot is that instant on the reader's clock.
        const tokyo = automation(`tokyo`, { kind: `schedule`, cron: `0 3 * * *`, tz: ZoneSchema.parse(`Asia/Tokyo`) });
        const [first] = calendarWeek([tokyo], addDays(week, 7), now, zone).entries;
        expect(first).toBeDefined();
        const inTokyo = new Intl.DateTimeFormat(`en-GB`, { timeZone: `Asia/Tokyo`, hour: `2-digit`, minute: `2-digit` }).format(first?.at);
        expect(inTokyo).toBe(`03:00`);
    });

    it(`skips an unparseable cron rather than failing the week`, () => {
        const broken = automation(`broken`, { kind: `schedule`, cron: `not a cron` }, { runs: [run(local(6, 4))] });
        expect(calendarWeek([broken], week, now, zone).entries.map((entry) => entry.state)).toEqual([`completed`]);
    });
});

describe(`layoutDay`, () => {
    const at = (...minutes: number[]): { minute: number }[] => minutes.map((minute) => ({ minute }));
    const shape = (items: { minute: number }[]) => layoutDay(items, 30).map((placed) => [placed.item.minute, placed.column, placed.columns]);

    it(`sets colliding slots side by side`, () => {
        expect(shape(at(180, 180, 190, 300))).toEqual([
            [180, 0, 3],
            [180, 1, 3],
            [190, 2, 3],
            [300, 0, 1],
        ]);
    });

    it(`reuses a column freed inside the same cluster`, () => {
        expect(shape(at(0, 20, 40))).toEqual([
            [0, 0, 2],
            [20, 1, 2],
            [40, 0, 2],
        ]);
    });
});

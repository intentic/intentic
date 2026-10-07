// The calendar lens over the automations list: where in one week each clock-driven automation has woken and will wake.
// Pure, so the week a reader sees is a function of the list, the clock and the zone, and is tested as one.
//
// Only `schedule` and `once` have a place in time; a webhook, a listener or a workspace moment does not, and the view
// names those rather than inventing a slot for them. The past is the run ledger (what actually happened, at the moment
// it happened, however late), the future is the cron rule read in the zone the daemon fires it in. A past slot with no
// ledger entry draws nothing: the ledger keeps twenty runs, and an empty cell must not read as a miss.

import type { AutomationRun, AutomationSummary } from "@intentic/sandbox-contract";
import { asZone, cronOptions, type Zone } from "@intentic/sandbox-contract/time";
import { Cron } from "croner";

/** More fires than this in any one day and the automation is a cadence, not a set of moments: it goes in the lane. */
export const MAX_PER_DAY = 6;

/** Everything a slot can say: a run's own outcome for the past, `upcoming` or `paused` for the future. */
export type EntryState = AutomationRun[`outcome`] | `upcoming` | `paused`;

export interface CalendarEntry {
    readonly key: string;
    readonly automation: AutomationSummary;
    readonly at: number;
    /** Which of the week's seven days, Monday first. */
    readonly day: number;
    /** Minutes past the reader's local midnight, which is where it sits in the column. */
    readonly minute: number;
    readonly state: EntryState;
    /** The ledger entry behind a past slot, for its detail and its transcript. */
    readonly run?: AutomationRun;
}

/** A frequent automation over the days it fires, drawn as one bar per unbroken stretch of them. */
export interface LaneBar {
    readonly key: string;
    readonly automation: AutomationSummary;
    /** First and last day it covers, inclusive, Monday = 0. */
    readonly from: number;
    readonly to: number;
    readonly paused: boolean;
}

export interface CalendarWeek {
    /** The seven local midnights, Monday first. */
    readonly days: readonly number[];
    readonly entries: readonly CalendarEntry[];
    readonly lane: readonly LaneBar[];
    /** Automations no clock drives, named beside the calendar rather than placed on it. */
    readonly elsewhere: readonly AutomationSummary[];
}

/* ---- the reader's week ---- */

// Every step goes through the local calendar (setDate, setHours) rather than adding milliseconds: a week holding a
// summer-time change has a 23- or 25-hour day, and arithmetic would put every slot after it an hour out.

/** Monday 00:00, on the reader's own clock, of the week holding `at`. */
export const weekStartOf = (at: number): number => {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return date.getTime();
};

/** `start` moved by whole days, landing on the same wall-clock time whatever summer time did in between. */
export const addDays = (start: number, days: number): number => {
    const date = new Date(start);
    date.setDate(date.getDate() + days);
    return date.getTime();
};

export const daysOf = (weekStart: number): number[] => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));

/** Minutes past local midnight, the column coordinate. */
export const minuteOfDay = (at: number): number => {
    const date = new Date(at);
    return date.getHours() * 60 + date.getMinutes();
};

/** A day and a minute in it, back to an instant: what a click on an empty slot means. */
export const instantAt = (day: number, minute: number): number => {
    const date = new Date(day);
    date.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    return date.getTime();
};

const dayIndex = (days: readonly number[], end: number, at: number): number => {
    if (at < (days[0] ?? 0) || at >= end) {
        return -1;
    }
    return days.findLastIndex((day) => day <= at);
};

/* ---- the rule ---- */

// A callback-less Cron is only a queryable pattern. Read in the automation's own zone, else the sandbox's: the zone
// the daemon fires it in, never the reader's. An unparseable cron (only a hand-edited manifest has one) has no fires.
const cronOf = (automation: AutomationSummary, sandbox: Zone): Cron | undefined => {
    const trigger = automation.trigger;
    if (trigger.kind !== `schedule`) {
        return undefined;
    }
    try {
        return new Cron(trigger.cron, cronOptions(asZone(trigger.tz) ?? sandbox));
    } catch {
        // allow(silent-catch): no fires is what an invalid cron has.
        return undefined;
    }
};

// Fires in [from, to), at most `limit` of them; `nextRun` is strictly after its argument, hence the millisecond back.
const firesBetween = (cron: Cron, from: number, to: number, limit: number): number[] => {
    const fires: number[] = [];
    let next = cron.nextRun(new Date(from - 1));
    while (next !== null && next.getTime() < to && fires.length < limit) {
        fires.push(next.getTime());
        next = cron.nextRun(next);
    }
    return fires;
};

// Whether a rule is a cadence this week. Judged over the WHOLE week, past days included, so one automation doesn't
// change shape at midnight; the busiest day decides.
const isFrequent = (cron: Cron, days: readonly number[], end: number): boolean => {
    const limit = days.length * MAX_PER_DAY + 1;
    const perDay = new Map<number, number>();
    for (const at of firesBetween(cron, days[0] ?? 0, end, limit)) {
        const day = dayIndex(days, end, at);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    return [...perDay.values()].some((count) => count > MAX_PER_DAY);
};

// Unbroken stretches of the days a frequent rule fires on, from `firstDay` on: Mon-Fri business hours is one bar, a
// rule skipping Wednesday is two.
const stretches = (cron: Cron, days: readonly number[], end: number, firstDay: number): [number, number][] => {
    const runs: [number, number][] = [];
    for (let day = firstDay; day < days.length; day++) {
        const dayEnd = days[day + 1] ?? end;
        if (firesBetween(cron, days[day] ?? 0, dayEnd, 1).length === 0) {
            continue;
        }
        const last = runs.at(-1);
        if (last !== undefined && last[1] === day - 1) {
            last[1] = day;
        } else {
            runs.push([day, day]);
        }
    }
    return runs;
};

const isClockDriven = (automation: AutomationSummary): boolean => automation.trigger.kind === `schedule` || automation.trigger.kind === `once`;

/**
 * One week of the calendar. `now` splits the ledger's past from the rule's future, and a frequent automation's bar
 * starts at today's column: the lane says what is coming, the ledger's strip inside it says what came.
 */
export const calendarWeek = (automations: readonly AutomationSummary[], weekStart: number, now: number, sandbox: Zone): CalendarWeek => {
    const days = daysOf(weekStart);
    const end = addDays(weekStart, 7);
    const entries: CalendarEntry[] = [];
    const lane: LaneBar[] = [];
    const entry = (automation: AutomationSummary, at: number, state: EntryState, run?: AutomationRun): void => {
        const day = dayIndex(days, end, at);
        if (day >= 0) {
            // Keyed without the state, so switching an automation off restyles its slots rather than replacing them: an
            // open popover is anchored to one.
            const key = `${automation.id}@${at}${run === undefined ? `` : `:run`}`;
            entries.push({ key, automation, at, day, minute: minuteOfDay(at), state, ...(run ? { run } : {}) });
        }
    };

    for (const automation of automations) {
        const trigger = automation.trigger;
        if (trigger.kind === `once`) {
            // Enabled, it is due at its moment, overdue included: the daemon fires an overdue one on its next poll.
            // Off and still ahead, it is paused; off and behind, it is spent, and the ledger below has its run.
            if (automation.enabled || trigger.at > now) {
                entry(automation, trigger.at, automation.enabled ? `upcoming` : `paused`);
            }
        }
        const cron = cronOf(automation, sandbox);
        if (cron !== undefined && isFrequent(cron, days, end)) {
            const today = now >= end ? days.length : Math.max(0, dayIndex(days, end, now));
            for (const [from, to] of stretches(cron, days, end, today)) {
                lane.push({ key: `${automation.id}:${from}`, automation, from, to, paused: !automation.enabled });
            }
            continue;
        }
        if (cron !== undefined) {
            for (const at of firesBetween(cron, Math.max(weekStart, now), end, days.length * MAX_PER_DAY)) {
                entry(automation, at, automation.enabled ? `upcoming` : `paused`);
            }
        }
        if (isClockDriven(automation)) {
            for (const run of automation.runs) {
                if (run.at < now) {
                    entry(automation, run.at, run.outcome, run);
                }
            }
        }
    }

    return {
        days,
        entries: entries.toSorted((a, b) => a.at - b.at || a.automation.id.localeCompare(b.automation.id)),
        lane: lane.toSorted((a, b) => a.from - b.from || a.automation.id.localeCompare(b.automation.id)),
        elsewhere: automations.filter((automation) => !isClockDriven(automation)),
    };
};

/* ---- one day's column ---- */

export interface Placed<T> {
    readonly item: T;
    /** Which side-by-side column it takes, and how many its cluster needed. */
    readonly column: number;
    readonly columns: number;
}

/**
 * Side-by-side columns for slots that would overlap, the way every calendar splits a double booking. `span` is how many
 * minutes a slot covers on screen: a wake has no duration of its own, so two fires closer than a slot's drawn height
 * are what collides. A cluster is every slot touching another; each takes the first column free at its start.
 */
export const layoutDay = <T extends { readonly minute: number }>(items: readonly T[], span: number): Placed<T>[] => {
    const placed: Placed<T>[] = [];
    let cluster: { item: T; column: number }[] = [];
    let columnEnds: number[] = [];
    let clusterEnd = Number.NEGATIVE_INFINITY;
    const close = (): void => {
        for (const member of cluster) {
            placed.push({ ...member, columns: columnEnds.length });
        }
        cluster = [];
        columnEnds = [];
    };
    for (const item of items.toSorted((a, b) => a.minute - b.minute)) {
        if (item.minute >= clusterEnd) {
            close();
        }
        const free = columnEnds.findIndex((columnEnd) => columnEnd <= item.minute);
        const column = free === -1 ? columnEnds.length : free;
        columnEnds[column] = item.minute + span;
        cluster.push({ item, column });
        clusterEnd = Math.max(clusterEnd, item.minute + span);
    }
    close();
    return placed;
};

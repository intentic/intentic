// The structured schedule the automations dialog edits instead of raw cron. `cronOf` composes the cron string;
// `parseCron` inverts it for the shapes the builder produces, falling back to freq "custom" with the raw string.
// `scheduleLabel` renders the human badge for the automations list.
import { asZone, type Zone, zoneLabel } from "@intentic/sandbox-contract/time";
import { t } from "./i18n";

export type ScheduleFreq = `minutes` | `hourly` | `daily` | `weekly` | `monthly` | `custom`;

export interface ScheduleState {
    freq: ScheduleFreq;
    everyMinutes: number; // minutes: 1-59
    time: string; // "HH:MM" 24h, daily/weekly/monthly
    days: number[]; // weekly: cron dow 0-6, 0 = Sunday
    dayOfMonth: number; // monthly: 1-31
    cron: string; // custom only
}

// Baseline used as the spread target when a parseCron result overwrites a reactive state.
export const defaultSchedule = (): ScheduleState => ({
    freq: `daily`,
    everyMinutes: 5,
    time: `09:00`,
    days: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    cron: ``,
});

const isIntIn = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max;

// "HH:MM" → [minute, hour]; undefined for a cleared time input or out-of-range values.
const timeParts = (time: string): [number, number] | undefined => {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match) {
        return undefined;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? [minute, hour] : undefined;
};

// undefined = not submittable yet (no days picked, blank custom, cleared/NaN inputs).
export const cronOf = (schedule: ScheduleState): string | undefined => {
    if (schedule.freq === `custom`) {
        return schedule.cron.trim() || undefined;
    }
    if (schedule.freq === `minutes`) {
        return isIntIn(schedule.everyMinutes, 1, 59) ? `*/${schedule.everyMinutes} * * * *` : undefined;
    }
    if (schedule.freq === `hourly`) {
        return `0 * * * *`;
    }
    const parts = timeParts(schedule.time);
    if (parts === undefined) {
        return undefined;
    }
    const [minute, hour] = parts;
    if (schedule.freq === `daily`) {
        return `${minute} ${hour} * * *`;
    }
    if (schedule.freq === `weekly`) {
        const days = [...new Set(schedule.days)].toSorted((a, b) => a - b);
        return days.length > 0 && days.every((day) => isIntIn(day, 0, 6)) ? `${minute} ${hour} * * ${days.join(`,`)}` : undefined;
    }
    return isIntIn(schedule.dayOfMonth, 1, 31) ? `${minute} ${hour} ${schedule.dayOfMonth} * *` : undefined;
};

// Dow field as comma-separated numbers or A-B ranges, 0-7 with 7 ≡ Sunday. Names, steps, "?" → undefined.
const parseDays = (field: string): number[] | undefined => {
    const days = new Set<number>();
    for (const token of field.split(`,`)) {
        const range = /^(\d+)(?:-(\d+))?$/.exec(token);
        if (!range) {
            return undefined;
        }
        const from = Number(range[1]);
        const to = Number(range[2] ?? range[1]);
        if (from > 7 || to > 7 || from > to) {
            return undefined;
        }
        for (let day = from; day <= to; day++) {
            days.add(day % 7);
        }
    }
    return [...days].toSorted((a, b) => a - b);
};

const pad = (value: number): string => String(value).padStart(2, `0`);

export const parseCron = (cron: string): ScheduleState => {
    const custom: ScheduleState = { ...defaultSchedule(), freq: `custom`, cron: cron.trim() };
    const fields = custom.cron.split(/\s+/);
    if (fields.length !== 5 || fields[3] !== `*`) {
        return custom;
    }
    const [minuteField = ``, hourField = ``, domField = ``, , dowField = ``] = fields;

    if (hourField === `*` && domField === `*` && dowField === `*`) {
        if (minuteField === `*`) {
            return { ...defaultSchedule(), freq: `minutes`, everyMinutes: 1 };
        }
        const step = /^\*\/(\d+)$/.exec(minuteField);
        if (step) {
            const everyMinutes = Number(step[1]);
            return isIntIn(everyMinutes, 1, 59) ? { ...defaultSchedule(), freq: `minutes`, everyMinutes } : custom;
        }
        return minuteField === `0` ? { ...defaultSchedule(), freq: `hourly` } : custom;
    }

    if (!/^\d+$/.test(minuteField) || !/^\d+$/.test(hourField)) {
        return custom;
    }
    const minute = Number(minuteField);
    const hour = Number(hourField);
    if (minute > 59 || hour > 23) {
        return custom;
    }
    const time = `${pad(hour)}:${pad(minute)}`;

    if (domField === `*` && dowField === `*`) {
        return { ...defaultSchedule(), freq: `daily`, time };
    }
    if (domField === `*`) {
        const days = parseDays(dowField);
        return days !== undefined && days.length > 0 ? { ...defaultSchedule(), freq: `weekly`, time, days } : custom;
    }
    if (dowField !== `*` || !/^\d+$/.test(domField)) {
        return custom;
    }
    const dayOfMonth = Number(domField);
    return isIntIn(dayOfMonth, 1, 31) ? { ...defaultSchedule(), freq: `monthly`, time, dayOfMonth } : custom;
};

/**
 * The two directions of a one-time wake's box. `datetime-local` speaks the reader's own wall clock with no zone
 * attached, which is exactly how a person means "3pm"; the stored trigger is an absolute instant. Converting here, at
 * the edge, is what makes a one-time wake immune to the timezone gap a cron lives with: the sandbox keeps its own
 * clock, and this moment means the same thing on any of them.
 */
export const localInputOf = (at: number): string => {
    const date = new Date(at);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** NaN for a cleared or half-typed box, which every caller reads as "not answered yet". */
export const instantOf = (local: string): number => new Date(local).getTime();

// Built when read, so the names follow the language on screen; Sunday first, as cron counts.
const dayNames = (): readonly string[] => [
    t(`automationFields.sun`),
    t(`automationFields.mon`),
    t(`automationFields.tue`),
    t(`automationFields.wed`),
    t(`automationFields.thu`),
    t(`automationFields.fri`),
    t(`automationFields.sat`),
];

// A language without suffixed ordinals spells all four the same (Polish: "1.").
const ordinal = (day: number): string => {
    if (day % 10 === 1 && day !== 11) {
        return t(`cronSchedule.ordinal.st`, { day });
    }
    if (day % 10 === 2 && day !== 12) {
        return t(`cronSchedule.ordinal.nd`, { day });
    }
    if (day % 10 === 3 && day !== 13) {
        return t(`cronSchedule.ordinal.rd`, { day });
    }
    return t(`cronSchedule.ordinal.th`, { day });
};

// Keeps `since`/`nextIn` narrow instead of using the kit's `timeAgo`, which falls back to full dates.
const MINUTES_PER_DAY = 60 * 24;

/** How long ago a run happened: "just now", "5m ago", "3h ago", "2d ago". */
export const since = (at: number): string => {
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) {
        return t(`cronSchedule.justNow`);
    }
    if (minutes < 60) {
        return t(`cronSchedule.minutesAgo`, { count: minutes }, minutes);
    }
    if (minutes < MINUTES_PER_DAY) {
        const hours = Math.round(minutes / 60);
        return t(`cronSchedule.hoursAgo`, { count: hours }, hours);
    }
    const days = Math.round(minutes / MINUTES_PER_DAY);
    return t(`cronSchedule.daysAgo`, { count: days }, days);
};

/**
 * How long until the next fire: "due", "in 5m", "in 3h", "in 2d"; a nextRun just in the past still reads "due" since
 * the scheduler polls and can lag behind the clock.
 */
export const nextIn = (at: number): string => {
    const minutes = Math.round((at - Date.now()) / 60_000);
    if (minutes < 1) {
        return t(`cronSchedule.due`);
    }
    if (minutes < 60) {
        return t(`cronSchedule.inMinutes`, { count: minutes }, minutes);
    }
    if (minutes < MINUTES_PER_DAY) {
        const hours = Math.round(minutes / 60);
        return t(`cronSchedule.inHours`, { count: hours }, hours);
    }
    const days = Math.round(minutes / MINUTES_PER_DAY);
    return t(`cronSchedule.inDays`, { count: days }, days);
};

// Full trigger rule as one phrase, e.g. "Daily 05:00 Europe/Warsaw · after 30 sessions".
export const scheduleTriggerLabel = (trigger: { readonly cron: string; readonly afterSessions?: number; readonly tz?: string }, reader: Zone, sandbox: Zone): string => {
    const label = scheduleLabel(trigger.cron, reader, (asZone(trigger.tz) ?? sandbox) as Zone);
    return trigger.afterSessions === undefined
        ? label
        : t(`cronSchedule.afterSessions`, { label, count: trigger.afterSessions }, trigger.afterSessions);
};

/**
 * Human badge for a stored cron. The zone is part of the badge, not decoration: "Daily 20:43" with no zone was read as
 * the reader's own 20:43 and fired at somebody else's, which is the entire bug this carries. Named only when the
 * reader is on a different clock — telling somebody in Warsaw that their schedule runs on Warsaw time is noise.
 * Unrecognized cron shapes pass the raw string through, zone and all, since there is no wall clock to qualify.
 */
export const scheduleLabel = (cron: string, reader: Zone, rule: Zone): string => {
    const schedule = parseCron(cron);
    const zone = zoneLabel(rule, reader);
    // Only the shapes that name an hour take a zone. "Every 5 min" and "Hourly" mean the same thing on every clock,
    // so qualifying them would be false precision.
    const qualify = (label: string): string => (zone === undefined ? label : `${label} ${zone}`);
    if (schedule.freq === `custom`) {
        // Every hour or every few hours off the hour, the shapes a watch checks on (`automations propose --every 6h`): the
        // builder has no row for them, but the list can still say them in words. An hour step means the same thing on
        // every clock, so no zone.
        const written = schedule.cron.trim();
        if (/^\d{1,2} \* \* \* \*$/.test(written)) {
            return t(`cronSchedule.hourly`);
        }
        const hours = /^\d{1,2} \*\/(\d{1,2}) \* \* \*$/.exec(written);
        return hours?.[1] === undefined ? schedule.cron : t(`cronSchedule.everyHours`, { count: Number(hours[1]) });
    }
    if (schedule.freq === `minutes`) {
        return t(`cronSchedule.everyMinutes`, { minutes: schedule.everyMinutes });
    }
    if (schedule.freq === `hourly`) {
        return t(`cronSchedule.hourly`);
    }
    if (schedule.freq === `daily`) {
        return qualify(t(`cronSchedule.daily`, { time: schedule.time }));
    }
    if (schedule.freq === `monthly`) {
        return qualify(t(`cronSchedule.monthly`, { day: ordinal(schedule.dayOfMonth), time: schedule.time }));
    }
    if (schedule.days.length === 7) {
        return qualify(t(`cronSchedule.everyDay`, { time: schedule.time }));
    }
    if (schedule.days.join(`,`) === `1,2,3,4,5`) {
        return qualify(t(`cronSchedule.weekdays`, { time: schedule.time }));
    }
    // Mon-first display order.
    const names = schedule.days.toSorted((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => dayNames()[day]);
    return qualify(`${names.join(`, `)} ${schedule.time}`);
};

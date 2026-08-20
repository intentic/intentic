/* The structured schedule the automations dialog edits instead of raw cron. `cronOf` composes the wire cron
 * string; `parseCron` inverts it for exactly the shapes the builder can produce (plus dow ranges like 1-5) and
 * falls back to freq "custom" carrying the raw string for anything else, so cron syntax only ever surfaces in
 * the explicit Custom mode. `scheduleLabel` renders the human badge for the automations list. */

export type ScheduleFreq = `minutes` | `hourly` | `daily` | `weekly` | `monthly` | `custom`;

export interface ScheduleState {
    freq: ScheduleFreq;
    everyMinutes: number; // minutes: 1-59
    time: string; // "HH:MM" 24h — daily/weekly/monthly
    days: number[]; // weekly: cron dow 0-6, 0 = Sunday
    dayOfMonth: number; // monthly: 1-31
    cron: string; // custom only
}

// Every field carries a sensible default so parseCron results can be Object.assign'ed over a reactive state.
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

const DAY_NAMES = [`Sun`, `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`];

const ordinal = (day: number): string => {
    if (day % 10 === 1 && day !== 11) {
        return `${day}st`;
    }
    if (day % 10 === 2 && day !== 12) {
        return `${day}nd`;
    }
    if (day % 10 === 3 && day !== 13) {
        return `${day}rd`;
    }
    return `${day}th`;
};

// The list's two time COLUMNS. Both stay narrow enough to align down the page, the exact timestamp rides the
// tooltip, which is why neither is the kit's `timeAgo`: that one falls back to a full date and time past a
// day, and three of those in a column is the end of scanning it.
const MINUTES_PER_DAY = 60 * 24;

/** How long ago a run happened: "just now", "5m ago", "3h ago", "2d ago". */
export const since = (at: number): string => {
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) {
        return `just now`;
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    if (minutes < MINUTES_PER_DAY) {
        return `${Math.round(minutes / 60)}h ago`;
    }
    return `${Math.round(minutes / MINUTES_PER_DAY)}d ago`;
};

/** How long until the next fire: "due", "in 5m", "in 3h", "in 2d". A nextRun that has just slipped into the
 *  past reads as "due" rather than as a miss, the daemon's scheduler picks changes up on a poll, so being a
 *  few seconds behind the clock is its normal state. */
export const nextIn = (at: number): string => {
    const minutes = Math.round((at - Date.now()) / 60_000);
    if (minutes < 1) {
        return `due`;
    }
    if (minutes < 60) {
        return `in ${minutes}m`;
    }
    if (minutes < MINUTES_PER_DAY) {
        return `in ${Math.round(minutes / 60)}h`;
    }
    return `in ${Math.round(minutes / MINUTES_PER_DAY)}d`;
};

// Human badge for a stored cron; unrecognized shapes pass the raw string through.
export const scheduleLabel = (cron: string): string => {
    const schedule = parseCron(cron);
    if (schedule.freq === `custom`) {
        return schedule.cron;
    }
    if (schedule.freq === `minutes`) {
        return `Every ${schedule.everyMinutes} min`;
    }
    if (schedule.freq === `hourly`) {
        return `Hourly`;
    }
    if (schedule.freq === `daily`) {
        return `Daily ${schedule.time}`;
    }
    if (schedule.freq === `monthly`) {
        return `Monthly ${ordinal(schedule.dayOfMonth)} ${schedule.time}`;
    }
    if (schedule.days.length === 7) {
        return `Every day ${schedule.time}`;
    }
    if (schedule.days.join(`,`) === `1,2,3,4,5`) {
        return `Weekdays ${schedule.time}`;
    }
    // Mon-first display order.
    const names = schedule.days.toSorted((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => DAY_NAMES[day]);
    return `${names.join(`, `)} ${schedule.time}`;
};

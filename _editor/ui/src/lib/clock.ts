// Days and times of day on the reader's own clock, as values: what a date grid lays out and what a time field reads.
// Every step goes through the local calendar (setDate, setMonth, setHours) rather than adding milliseconds, so a day
// holding a summer-time change still starts at its own midnight. Pure, with the clock and the first weekday handed in.

const MINUTES_PER_DAY = 24 * 60;

/** Local midnight of the day holding `at`. */
export const dayOf = (at: number): number => new Date(at).setHours(0, 0, 0, 0);

/** `day` moved by whole days, landing on the same wall-clock time whatever summer time did in between. */
export const addDays = (day: number, days: number): number => {
    const date = new Date(day);
    date.setDate(date.getDate() + days);
    return date.getTime();
};

/** Local midnight of the first of the month holding `at`, moved by `months` (negative goes back). */
export const monthOf = (at: number, months = 0): number => {
    const date = new Date(at);
    return new Date(date.getFullYear(), date.getMonth() + months, 1).getTime();
};

/** Minutes past local midnight. */
export const minuteOfDay = (at: number): number => {
    const date = new Date(at);
    return date.getHours() * 60 + date.getMinutes();
};

/** A day and minutes past its midnight, back to an instant on the reader's own clock. */
export const atMinute = (day: number, minutes: number): number => new Date(day).setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);

/** One cell of a month's grid. */
export interface MonthDay {
    /** Local midnight. */
    readonly day: number;
    /** Its number in its month, 1 to 31. */
    readonly date: number;
    /** It belongs to the month the grid is for, not the days that fill its first and last weeks. */
    readonly inMonth: boolean;
    readonly today: boolean;
}

/**
 * The month holding `month` as six whole weeks starting on `firstWeekday` (0 Sunday … 6 Saturday, as `getDay` counts).
 * Always six, so paging from a four-week February to a six-week month never moves what is under the pointer.
 */
export const monthWeeks = (month: number, firstWeekday: number, now: number): readonly (readonly MonthDay[])[] => {
    const first = monthOf(month);
    const shown = new Date(first).getMonth();
    const today = dayOf(now);
    const lead = (new Date(first).getDay() - firstWeekday + 7) % 7;
    const weeks: MonthDay[][] = [];
    let day = addDays(first, -lead);
    for (let week = 0; week < 6; week += 1) {
        const days: MonthDay[] = [];
        for (let index = 0; index < 7; index += 1, day = addDays(day, 1)) {
            const date = new Date(day);
            days.push({ day, date: date.getDate(), inMonth: date.getMonth() === shown, today: day === today });
        }
        weeks.push(days);
    }
    return weeks;
};

/* ---- the time of day ---- */

// "9", "09", "930", "0930", "9:30", "9.30", "9h30", "21:30", "9pm", "9:30 am", "12am". One or two hour digits, then
// optionally two minute digits behind an optional separator, then optionally a twelve-hour suffix.
const CLOCK = /^(\d{1,2})(?:\s*[:.h]?\s*(\d{2}))?\s*h?\s*(am?|pm?)?$/;

/** The minutes past midnight a typed time names, read forgivingly; undefined for anything that is not one. */
export const parseClock = (text: string): number | undefined => {
    const match = CLOCK.exec(text.trim().toLowerCase());
    if (match === null) {
        return undefined;
    }
    let hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const half = match[3]?.[0];
    if (half !== undefined) {
        if (hour < 1 || hour > 12) {
            return undefined;
        }
        hour = (hour % 12) + (half === `p` ? 12 : 0);
    }
    return hour > 23 || minute > 59 ? undefined : hour * 60 + minute;
};

/** Minutes past midnight as the field shows them: the house's 24-hour "09:30". */
export const clockText = (minutes: number): string => {
    const pad = (value: number): string => String(value).padStart(2, `0`);
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};

/** The arrow keys' step: to the next quarter hour up or down, round the clock. */
export const stepClock = (minutes: number, direction: 1 | -1): number => {
    const QUARTER = 15;
    const stepped = direction === 1 ? Math.floor(minutes / QUARTER) * QUARTER + QUARTER : Math.ceil(minutes / QUARTER) * QUARTER - QUARTER;
    return (stepped + MINUTES_PER_DAY) % MINUTES_PER_DAY;
};

/** Every time of day `step` minutes apart, from midnight: what a time field's list offers. */
export const clockSlots = (step: number): readonly number[] =>
    Array.from({ length: Math.ceil(MINUTES_PER_DAY / step) }, (_, index) => index * step);

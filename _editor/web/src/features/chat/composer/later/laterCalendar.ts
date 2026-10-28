import { addDays, atMinute, dayOf, minuteOfDay } from "@intentic/ui/clock";
import { bookable, LATEST_SEND_MS, SOONEST_SEND_MS } from "../../../../models/conversations/drafts/sendLater";

// The day and time arithmetic is the kit's (clock.ts), shared with its own date and time fields.
export { addDays, atMinute, clockText, dayOf, minuteOfDay, parseClock, stepClock } from "@intentic/ui/clock";

// The send-later panel's own picker, as values: the days a booking can land on, laid out as the weeks they fall in,
// and a time of day the reader types or presses. Pure, with the clock and the first weekday handed in; every step goes
// through the local calendar (setDate, setHours) rather than adding milliseconds, so a day holding a summer-time change
// still starts at its own midnight.
//
// The sandbox keeps a booking up to thirty days (sendLater.ts), so the whole window is five or six weeks: the picker
// draws all of it at once, from the week holding today to the week holding the last bookable day, and never pages
// through months. The first of a month is labelled where it falls instead.

const MINUTES_PER_DAY = 24 * 60;

export interface CalendarDay {
    /** Local midnight. */
    readonly day: number;
    /** Its number in the month, 1 to 31. */
    readonly date: number;
    /** The first of a month: where the grid says which month it has moved into. */
    readonly monthStart: boolean;
    readonly today: boolean;
    /** Some minute of it can still be booked. */
    readonly bookable: boolean;
}

/** The first and last day a booking can land on, as local midnights. */
export interface BookableDays {
    readonly first: number;
    readonly last: number;
}

export const bookableDays = (now: number): BookableDays => ({
    first: dayOf(now + SOONEST_SEND_MS),
    last: dayOf(now + LATEST_SEND_MS),
});

/**
 * The weeks the booking window spans, whole weeks starting on `firstWeekday` (0 Sunday … 6 Saturday, as `getDay`
 * counts): from the week holding today, bookable or not, to the week holding the last bookable day.
 */
export const calendarWeeks = (now: number, firstWeekday: number): readonly (readonly CalendarDay[])[] => {
    const { first, last } = bookableDays(now);
    const today = dayOf(now);
    const lead = (new Date(today).getDay() - firstWeekday + 7) % 7;
    const weeks: CalendarDay[][] = [];
    for (let day = addDays(today, -lead); day <= last;) {
        const week: CalendarDay[] = [];
        for (let index = 0; index < 7; index += 1, day = addDays(day, 1)) {
            const date = new Date(day).getDate();
            week.push({ day, date, monthStart: date === 1, today: day === today, bookable: day >= first && day <= last });
        }
        weeks.push(week);
    }
    return weeks;
};

/** The day keyboard movement lands on: `day` moved by `by` days, held inside the bookable window. */
export const moveDay = (day: number, by: number, now: number): number => {
    const { first, last } = bookableDays(now);
    return Math.min(last, Math.max(first, addDays(day, by)));
};

/* ---- the time of day ---- */

/** The times offered as one press beside the field: the morning, midday, the afternoon and the evening. */
export const CLOCK_CHIPS: readonly number[] = [9 * 60, 12 * 60, 15 * 60, 18 * 60];

const MORNING = 9 * 60;

/**
 * The time a picked day gets before the reader names one. On the soonest bookable day, the next whole hour still
 * ahead (or quarter hour, or minute, as the day runs out of them); on any later day nine in the morning, the hour
 * "Tomorrow morning" already means.
 */
export const defaultClock = (day: number, now: number): number => {
    const soonest = now + SOONEST_SEND_MS;
    if (day !== dayOf(soonest)) {
        return MORNING;
    }
    // Wall-clock minutes, rounded up: on the day summer time changes, milliseconds since midnight are an hour out.
    const at = new Date(soonest);
    const from = minuteOfDay(soonest) + (at.getSeconds() > 0 || at.getMilliseconds() > 0 ? 1 : 0);
    for (const step of [60, 15, 1]) {
        const minutes = Math.ceil(from / step) * step;
        if (minutes < MINUTES_PER_DAY) {
            return minutes;
        }
    }
    return MINUTES_PER_DAY - 1;
};

/** What the reader has picked so far: a day, a time of day, both or neither. */
export interface LaterDraft {
    readonly day?: number | undefined;
    readonly clock?: number | undefined;
}

/**
 * The instant a draft names. A day without a time takes `defaultClock`; a time without a day is its next one, today
 * while it is still ahead and tomorrow once it has passed; neither names nothing. Whether the sandbox will take it is
 * `bookable`'s to say.
 */
export const draftInstant = ({ day, clock }: LaterDraft, now: number): number | undefined => {
    if (day !== undefined) {
        return atMinute(day, clock ?? defaultClock(day, now));
    }
    if (clock === undefined) {
        return undefined;
    }
    const today = atMinute(dayOf(now), clock);
    return bookable(today, now) ? today : atMinute(addDays(dayOf(now), 1), clock);
};

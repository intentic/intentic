import { t } from "@intentic/ui/i18n";
import { formatUntil } from "@intentic/ui/time";

// When the composer's next message goes, when not now: at an instant the reader chose, or once another agent's work
// has landed in the workspace. Picked from the send's own caret (ChatPane), where a pick is the send itself: the words
// go to the queue booked for it. Held on the composer only when it came back with words being edited (TurnClient's
// takenBack) or from a typed token (composerQuickPick), and then the send says when it goes and its press books it. Where the message waits after
// that is the conversation's queue, the daemon's, which every window draws as scheduled and where it can be sent
// sooner, re-timed, or taken back into the composer to be edited, each booked message on its own time (bookings.ts). Pure and value-typed;
// the clock is always handed in.

export type SendLater = { readonly kind: `at`; readonly at: number } | { readonly kind: `after`; readonly conversationId: string };

/** The wire's spelling of a pick: what `agent.run` and `agent.queueSchedule` take beside the words. */
export type TurnBooking = { readonly sendAt: number; readonly sendAfter?: undefined } | { readonly sendAfter: string; readonly sendAt?: undefined };

export const bookingOf = (later: SendLater): TurnBooking => (later.kind === `at` ? { sendAt: later.at } : { sendAfter: later.conversationId });

/**
 * The pick a queue's own `scheduled` reads as; undefined for any other hold. Every message's booking on a sandbox that
 * books the whole queue, the soonest one's on a sandbox that books each message (bookings.ts reads which).
 */
export const laterOfQueue = (queue: { readonly paused?: string | undefined; readonly until?: number | undefined; readonly after?: string | undefined } | undefined): SendLater | undefined => {
    if (queue?.paused !== `scheduled`) {
        return undefined;
    }
    if (queue.after !== undefined) {
        return { kind: `after`, conversationId: queue.after };
    }
    return queue.until === undefined ? undefined : { kind: `at`, at: queue.until };
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The farthest a time may be picked. The sandbox keeps a booking up to a month (turn-admission.ts); a day short of it
// keeps a time picked at the edge from being clamped behind the reader's back.
export const LATEST_SEND_MS = 30 * DAY;

// The nearest a picked time may be: closer than this it is "now" with extra steps, and Send already says that.
export const SOONEST_SEND_MS = MINUTE;

/** Whether an instant can be booked against `now`: ahead of it, and no further than the sandbox keeps a booking. */
export const bookable = (at: number, now: number): boolean => at - now >= SOONEST_SEND_MS && at - now <= LATEST_SEND_MS;

/** One quick time: its name, and the instant it means right now. */
export interface TimeChoice {
    readonly key: `hour` | `hours` | `tonight` | `morning` | `monday`;
    readonly label: string;
    readonly at: number;
}

// The next whole minute, so "in an hour" reads 15:41 rather than a time with seconds nobody asked for.
const wholeMinute = (at: number): number => Math.ceil(at / MINUTE) * MINUTE;

// `hour`:00 on the day `days` after now's, on the reader's own clock.
const clockOn = (now: number, days: number, hour: number): number => {
    const day = new Date(now);
    day.setDate(day.getDate() + days);
    day.setHours(hour, 0, 0, 0);
    return day.getTime();
};

// Where "tonight" stops being worth its own row: closer than the three hours the row above it already offers.
const TONIGHT_HOUR = 22;
const MORNING_HOUR = 9;
const FRIDAY = 5;
const SATURDAY = 6;

/**
 * The quick times, in the order they read: an hour or three out for later today, tonight for a run while nobody works,
 * tomorrow morning for first thing, and Monday morning from a Friday or a Saturday, for after the weekend (a Sunday's
 * tomorrow already is). Each is computed against `now` on the reader's own clock.
 */
export const timeChoices = (now: number): readonly TimeChoice[] => {
    const choices: TimeChoice[] = [
        { key: `hour`, label: t(`chat.sendLater.inAnHour`), at: wholeMinute(now + HOUR) },
        { key: `hours`, label: t(`chat.sendLater.inThreeHours`), at: wholeMinute(now + 3 * HOUR) },
    ];
    const tonight = clockOn(now, 0, TONIGHT_HOUR);
    if (tonight - now > 3 * HOUR) {
        choices.push({ key: `tonight`, label: t(`chat.sendLater.tonight`), at: tonight });
    }
    choices.push({ key: `morning`, label: t(`chat.sendLater.tomorrowMorning`), at: clockOn(now, 1, MORNING_HOUR) });
    const weekday = new Date(now).getDay();
    if (weekday === FRIDAY || weekday === SATURDAY) {
        choices.push({ key: `monday`, label: t(`chat.sendLater.mondayMorning`), at: clockOn(now, weekday === FRIDAY ? 3 : 2, MORNING_HOUR) });
    }
    return choices;
};

/** One whole hour on the send-later menu's grid: the instant, and whether it falls on a later day than now's. */
export interface HourChoice {
    readonly at: number;
    readonly nextDay: boolean;
}

// How many hours the grid offers: half a day, four to a row. A later day, or a minute that is not on the hour, is the
// panel's other time (LaterTimePicker), one row below.
export const HOUR_CHOICES = 12;

/**
 * THE SEND MENU'S FIRST CHOICE IS AN HOUR. People schedule against the clock ("at 2, when the limit is back", "at 9,
 * when I am in"), and half a day of whole hours covers nearly every booking in one press, the night ones included. The
 * next whole hour still a minute ahead, then each one after it, on the reader's own clock (summer time moves the
 * instants, never the labels). A date is the advanced case, behind its own row.
 */
export const hourChoices = (now: number, count: number = HOUR_CHOICES): readonly HourChoice[] => {
    const cursor = new Date(now);
    cursor.setMinutes(0, 0, 0);
    cursor.setHours(cursor.getHours() + 1);
    if (!bookable(cursor.getTime(), now)) {
        cursor.setHours(cursor.getHours() + 1);
    }
    const today = new Date(now).toDateString();
    const hours: HourChoice[] = [];
    while (hours.length < count) {
        hours.push({ at: cursor.getTime(), nextDay: cursor.toDateString() !== today });
        cursor.setHours(cursor.getHours() + 1);
    }
    return hours;
};

/** A wait as the hour grid says it under each hour: "45m", "2h", "2h 15m". */
export const waitText = (at: number, now: number): string => {
    const minutes = Math.max(1, Math.round((at - now) / MINUTE));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) {
        return t(`chat.sendLater.waitMinutes`, { minutes: rest });
    }
    return rest === 0 ? t(`chat.sendLater.waitHours`, { hours }) : t(`chat.sendLater.waitHoursMinutes`, { hours, minutes: rest });
};

/**
 * A pick as the pill, the hint and the held message say it: the time it goes (the kit's `formatUntil`, "22:00 today",
 * "09:00 tomorrow", then the weekday or the date: a booked time is an appointment, read the way a calendar reads it), or after which agent's work lands, that
 * agent named by its card's title (`titleOf`), or as another agent when no card names it any more.
 */
export const laterLabel = (later: SendLater, now: number, titleOf: (conversationId: string) => string | undefined): string =>
    later.kind === `at`
        ? formatUntil(later.at, now)
        : t(`chat.sendLater.afterLands`, { title: titleOf(later.conversationId) ?? t(`chat.sendLater.anotherAgent`) });

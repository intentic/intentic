import { t } from "@intentic/ui/i18n";
import { formatUntil } from "@intentic/ui/time";

// When the composer's next message goes, when not now: at an instant the reader chose, or once another agent's work
// has landed in the workspace. A setting of the composer like its model or mode, not words in the message: it rides
// the row as a pill while set, turns Send into a booking, and is spent by that booking. Where the message waits after
// that is the conversation's queue, the daemon's, which every window draws as scheduled and where it can be sent
// sooner, re-timed, reworded or taken back. Pure and value-typed; the clock is always handed in.

export type SendLater = { readonly kind: `at`; readonly at: number } | { readonly kind: `after`; readonly conversationId: string };

/** The wire's spelling of a pick: what `agent.run` and `agent.queueSchedule` take beside the words. */
export type TurnBooking = { readonly sendAt: number; readonly sendAfter?: undefined } | { readonly sendAfter: string; readonly sendAt?: undefined };

export const bookingOf = (later: SendLater): TurnBooking => (later.kind === `at` ? { sendAt: later.at } : { sendAfter: later.conversationId });

/** The pick a queue's hold reads as, for the panel that re-times it; undefined for any other hold. */
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

/**
 * A pick as the pill, the hint and the held message say it: the time it goes (the kit's `formatUntil`, "22:00 today",
 * "09:00 tomorrow", then the weekday or the date: a booked time is an appointment, read the way a calendar reads it), or after which agent's work lands, that
 * agent named by its card's title (`titleOf`), or as another agent when no card names it any more.
 */
export const laterLabel = (later: SendLater, now: number, titleOf: (conversationId: string) => string | undefined): string =>
    later.kind === `at`
        ? formatUntil(later.at, now)
        : t(`chat.sendLater.afterLands`, { title: titleOf(later.conversationId) ?? t(`chat.sendLater.anotherAgent`) });

// The value a `datetime-local` field holds for an instant, on the reader's own clock: "2026-10-02T15:40".
export const localInputOf = (at: number): string => {
    const date = new Date(at);
    const pad = (value: number): string => String(value).padStart(2, `0`);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** The instant a `datetime-local` field's value names on the reader's own clock; undefined for an empty or partial one. */
export const instantOfInput = (value: string): number | undefined => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
        return undefined;
    }
    const at = new Date(value).getTime();
    return Number.isNaN(at) ? undefined : at;
};

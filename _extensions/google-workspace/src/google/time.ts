import { UsageError } from "../cli/args.js";

/* WHEN SOMETHING HAPPENS, from what a model will actually type.
 *
 * Google's calendar API wants RFC 3339 with an offset, and nothing that reaches this tool has one: a model
 * asked to "book something tomorrow at 2" types `tomorrow 14:00`, and a model reading its own earlier output
 * types `2026-08-12T14:00`. Rejecting those would make the calendar commands unusable in exactly the way they
 * are meant to be used, so they are accepted and resolved here.
 *
 * A NAIVE TIME IS A TIME IN THE CALENDAR'S OWN ZONE, not in the container's. The sandbox runs in UTC and the
 * owner does not, so "2pm" resolved against the process clock would book meetings an hour or two out all
 * summer. Google will do the conversion itself given `{dateTime, timeZone}`, so for writes that pair is sent
 * rather than an instant computed here; for the query parameters that must be absolute, the offset is worked
 * out from the zone with Intl. */

// "+02:00" for a zone at a moment. DST included, because Intl knows and arithmetic does not.
export const offsetOf = (timeZone: string, at: Date): string => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at);
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
    const offset = name.replace("GMT", "");
    return offset === "" ? "+00:00" : offset;
};

// The calendar date at a moment, in a zone, "today" is a question only a zone can answer.
export const dateIn = (timeZone: string, at: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);

const RELATIVE = /^([+-])(\d+)\s*(m|min|h|hour|hours|d|day|days|w|week|weeks)$/i;
const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, hour: 3_600_000, hours: 3_600_000 };
const DAY_MS = 86_400_000;

const shift = (match: RegExpExecArray, now: Date): Date => {
    const size = Number.parseInt(match[2] as string, 10);
    const unit = (match[3] as string).toLowerCase();
    const ms = UNIT_MS[unit] ?? (unit.startsWith("w") ? 7 * DAY_MS : DAY_MS);
    return new Date(now.getTime() + (match[1] === "-" ? -1 : 1) * size * ms);
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)$/;
const ABSOLUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const NAMED = /^(today|tomorrow|yesterday)(?:\s+(\d{2}:\d{2}(?::\d{2})?))?$/i;

const ACCEPTED_WHEN =
    "accepted: `now`, `+2h` / `-30m` / `+3d` / `+1w`, `today 14:00`, `tomorrow`, `2026-08-12`, `2026-08-12 14:00`, or a full RFC-3339 timestamp";

// What Google's event start/end object should be. `date` is an all-day event, a bare date means the whole
// day, which is what someone typing one means.
export interface EventTime {
    readonly date?: string;
    readonly dateTime?: string;
    readonly timeZone?: string;
}

export const parseWhen = (text: string, now: Date, timeZone: string): EventTime => {
    const value = text.trim();
    if (value.toLowerCase() === "now") {
        return { dateTime: now.toISOString() };
    }
    const relative = RELATIVE.exec(value);
    if (relative !== null) {
        return { dateTime: shift(relative, now).toISOString() };
    }
    const named = NAMED.exec(value);
    if (named !== null) {
        const offsetDays = { today: 0, tomorrow: 1, yesterday: -1 }[(named[1] as string).toLowerCase()] ?? 0;
        const day = dateIn(timeZone, new Date(now.getTime() + offsetDays * DAY_MS));
        return named[2] === undefined ? { date: day } : { dateTime: `${day}T${named[2].length === 5 ? `${named[2]}:00` : named[2]}`, timeZone };
    }
    if (DATE_ONLY.test(value)) {
        return { date: value };
    }
    if (ABSOLUTE.test(value)) {
        return { dateTime: value };
    }
    const naive = NAIVE.exec(value);
    if (naive !== null) {
        const time = naive[2] as string;
        return { dateTime: `${naive[1]}T${time.length === 5 ? `${time}:00` : time}`, timeZone };
    }
    throw new UsageError(`"${text}" is not a time this understands — ${ACCEPTED_WHEN}`);
};

/* What an event ends at when nobody said: an hour later, or, for an all-day event, the next day, because
 * Google's `end.date` is EXCLUSIVE and a start and end on the same date is a zero-length event it rejects.
 *
 * The naive case advances the WALL CLOCK by an hour rather than the instant: 14:00 in Berlin ends at 15:00 in
 * Berlin. Reading the naive string as UTC purely to do the arithmetic is what keeps it naive on the way out. */
export const defaultEnd = (start: EventTime): EventTime => {
    if (start.date !== undefined) {
        return { date: new Date(new Date(`${start.date}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10) };
    }
    const naive = start.dateTime ?? new Date().toISOString();
    if (start.timeZone === undefined) {
        return { dateTime: new Date(new Date(naive).getTime() + 3_600_000).toISOString() };
    }
    return { dateTime: new Date(new Date(`${naive}Z`).getTime() + 3_600_000).toISOString().slice(0, 19), timeZone: start.timeZone };
};

// The same value where the API insists on an absolute instant (timeMin/timeMax, freeBusy).
export const toInstant = (text: string, now: Date, timeZone: string): string => {
    const parsed = parseWhen(text, now, timeZone);
    if (parsed.dateTime !== undefined && parsed.timeZone === undefined) {
        return parsed.dateTime;
    }
    const naive = parsed.dateTime ?? `${parsed.date}T00:00:00`;
    // The offset is taken at the naive time read as UTC, within a few hours of the real instant, which is
    // near enough to pick the right side of a DST boundary except for the hour it moves, and there is no
    // exact answer for that hour anyway.
    return `${naive}${offsetOf(timeZone, new Date(`${naive}Z`))}`;
};

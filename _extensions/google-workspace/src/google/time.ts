import { UsageError } from "../cli/args.js";

// Resolves what a model actually types (`tomorrow 14:00`, `2026-08-12T14:00`) into RFC 3339 with an offset, what
// Google's calendar API wants. A naive time is read in the calendar's own zone, not the container's, since the sandbox
// runs UTC; writes send `{dateTime, timeZone}` so Google converts it.

// "+02:00" for a zone at a moment, DST included.
export const offsetOf = (timeZone: string, at: Date): string => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at);
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
    const offset = name.replace("GMT", "");
    return offset === "" ? "+00:00" : offset;
};

// The calendar date at a moment, in a zone: "today" is a question only a zone can answer.
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

// Google's event start/end shape; `date` alone means an all-day event, the whole day.
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
    throw new UsageError(`"${text}" is not a time this understands: ${ACCEPTED_WHEN}`);
};

// The default end when nobody said one: an hour later, or the next day for an all-day event (Google's `end.date` is
// exclusive). Advances the wall clock, not the instant, so a naive time stays naive.
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

// The same value where the API needs an absolute instant (timeMin/timeMax, freeBusy).
export const toInstant = (text: string, now: Date, timeZone: string): string => {
    const parsed = parseWhen(text, now, timeZone);
    if (parsed.dateTime !== undefined && parsed.timeZone === undefined) {
        return parsed.dateTime;
    }
    const naive = parsed.dateTime ?? `${parsed.date}T00:00:00`;
    // Offset taken at the naive time read as UTC: near enough except within the hour a DST boundary moves.
    return `${naive}${offsetOf(timeZone, new Date(`${naive}Z`))}`;
};

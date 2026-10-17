import { windowPeriod } from "@intentic/sandbox-contract/models/plan-pools";
import { utcDayOf } from "@intentic/sandbox-contract/time/zone";

// When a spent allowance reopens, as the vendor's own sentence says it. Every loop hands a spent allowance over with an
// instant of its own (a retry delay, a translator's bench), and those are when the LOOP would ask again, not when the
// plan reopens: OpenCode caps a provider's retry-after at fifteen minutes and CLIProxyAPI benches a credential for
// thirty, so a quota the vendor said "Resets in 166h40m39s" was booked for a re-run fifteen minutes out, and a Kimi
// five-hour window with two hours left for one in thirty (2026-10-17). The vendor's words outrank both; a loop's instant
// is only a floor.

// The longest an instant read off a sentence is believed: a month, the longest cycle any plan sells. Anything further
// is a misread, and an absurd instant would park a turn for good.
const LONGEST_SECONDS = 31 * 24 * 3_600;

const UNIT_SECONDS = new Map([
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
]);

// "166h40m39s", "2h 5m", "3 days", "45 minutes", "1d 2h": a run of counted units after "reset(s) in".
// allow(dependency-text): the vendors' own wording (Google's "Resets in 166h40m39s.", Anthropic's "resets in 3h").
const RESETS_IN = /\bresets?\s+in\s+((?:\d+(?:\.\d+)?\s*(?:d(?:ays?)?|h(?:(?:ou)?rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)[\s,]*(?:and\s+)?)+)/i;
const COUNTED = /(\d+(?:\.\d+)?)\s*([dhms])/gi;

// "try again at 5:46 PM", "try again at 17:46", "resets at 9am": a time of day, on the clock of the machine the
// vendor's loop runs on, which is this container's, UTC (time/zone.ts): Codex's "try again at 5:46 PM" said at 13:11
// UTC of a five-hour window was 17:46 UTC (2026-10-17).
// allow(dependency-text): Codex's "send a request to your admin or try again at 5:46 PM", Cursor's "try again at 3:38 PM".
const AT_CLOCK = /\b(?:try\s+again|resets?|available\s+again)\s+(?:at|after)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?![\d:])/i;

// "resets at 2026-10-24T10:00:00Z": an instant written out whole.
const AT_INSTANT =
    /\b(?:try\s+again|resets?|available\s+again)\s+(?:at|after|on)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i;

// A JSON body's own count: `"reset_seconds": 3600`, `"resets_in_seconds": 3600`.
const SECONDS_FIELD = /"(?:reset_seconds|resets_in_seconds|reset_after_seconds)"\s*:\s*(\d+(?:\.\d+)?)/;

const inRange = (seconds: number, nowSeconds: number): number | undefined =>
    seconds > nowSeconds && seconds - nowSeconds <= LONGEST_SECONDS ? Math.ceil(seconds) : undefined;

const countedSpan = (span: string): number =>
    [...span.matchAll(COUNTED)].reduce((sum, [, count, unit]) => sum + Number(count) * (UNIT_SECONDS.get((unit ?? "s").toLowerCase()) ?? 0), 0);

// The next time a UTC clock reads this hour and minute, today or tomorrow.
const nextClock = (match: RegExpExecArray, now: number): number | undefined => {
    const hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[3]?.toLowerCase().replaceAll(".", "");
    if (minute > 59 || (meridiem === undefined ? hour > 23 : hour < 1 || hour > 12)) {
        return undefined;
    }
    // A bare "at 9" with no minutes and no meridiem is a count, not a clock.
    if (meridiem === undefined && match[2] === undefined) {
        return undefined;
    }
    const hours = meridiem === undefined ? hour : (hour % 12) + (meridiem === "pm" ? 12 : 0);
    const today = Date.parse(`${utcDayOf(now)}T${String(hours).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
    return (today <= now ? today + DAY_MS : today) / 1000;
};

const DAY_MS = 24 * 60 * 60_000;

/**
 * When the vendor's sentence says the allowance reopens, in epoch seconds; undefined when it names no instant, or one
 * in the past or further off than any plan's cycle. Read first: "Resets in …", a written instant, a time of day, then a
 * JSON body's own seconds field.
 */
export const namedReset = (message: string, now: number = Date.now()): number | undefined => {
    const nowSeconds = now / 1000;
    const span = RESETS_IN.exec(message);
    if (span?.[1] !== undefined) {
        const seconds = countedSpan(span[1]);
        if (seconds > 0) {
            return inRange(nowSeconds + seconds, nowSeconds);
        }
    }
    const instant = AT_INSTANT.exec(message)?.[1];
    if (instant !== undefined) {
        const parsed = Date.parse(instant);
        if (!Number.isNaN(parsed)) {
            return inRange(parsed / 1000, nowSeconds);
        }
    }
    const clock = AT_CLOCK.exec(message);
    const atClock = clock === null ? undefined : nextClock(clock, now);
    if (atClock !== undefined) {
        return inRange(atClock, nowSeconds);
    }
    const field = SECONDS_FIELD.exec(message)?.[1];
    return field === undefined ? undefined : inRange(nowSeconds + Number(field), nowSeconds);
};

// "your 5-hour usage limit", "the weekly limit", "daily quota": the pool the sentence says ran out, by its length.
// allow(dependency-text): Kimi's "You've reached your 5-hour usage limit", Anthropic's "weekly limit".
const NAMED_POOL =
    /\b((?:\d+|five|seven)[-\s](?:hour|day|minute)s?|weekly|daily|monthly)\b[^.]{0,24}?\b(?:usage\s+)?(?:limit|quota|allowance|window)\b/i;

/** How long the pool the sentence says ran out runs, in seconds; undefined when it names no pool by its length. */
export const namedPeriod = (message: string): number | undefined => {
    const named = NAMED_POOL.exec(message)?.[1];
    return named === undefined ? undefined : windowPeriod({ kind: "named", label: named })?.seconds;
};

/** The latest of the instants given, ignoring undefineds: a turn re-run before every one of them would be refused again. */
export const latestOf = (...instants: readonly (number | undefined)[]): number | undefined =>
    instants.reduce<number | undefined>((latest, at) => (at !== undefined && (latest === undefined || at > latest) ? at : latest), undefined);

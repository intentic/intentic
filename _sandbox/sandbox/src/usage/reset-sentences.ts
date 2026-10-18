import { windowPeriod } from "@intentic/sandbox-contract/models/plan-pools";
import { type CivilDay, civilDayIn, localZone, nextDayStartIn, utcDayOf, wallClockInstant, type Zone } from "@intentic/sandbox-contract/time/zone";

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

// "166h40m39s", "2h 5m", "3 days", "45 minutes", "1d 2h": a run of counted units after "reset(s) in". A unit ends where
// its word does: unbounded, "resets in 1 month" read as one minute and booked a re-run sixty seconds out.
// allow(dependency-text): the vendors' own wording (Google's "Resets in 166h40m39s.", Anthropic's "resets in 3h").
const RESETS_IN =
    /\bresets?\s+in\s+((?:\d+(?:\.\d+)?\s*(?:d(?:ays?)?|h(?:(?:ou)?rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)(?![a-z])[\s,]*(?:and\s+)?)+)/i;
const COUNTED = /(\d+(?:\.\d+)?)\s*([dhms])/gi;

/* "try again at 5:46 PM", "try again at 17:46", "resets at 9am": a time of day, on the wall clock of the machine the
   vendor's loop runs on. Codex prints its reset in its own process's local time, and that process is this one's child
   with this one's zone: a UTC container's by default (time/zone.ts), so "try again at 10:05 PM" said at 18:15 UTC was
   its reading's 22:05:58 UTC (2026-10-13, run-outs.ts). Read in this process's zone rather than in UTC, so a container
   started with TZ set reads its loop's clock too instead of an offset away. */
// allow(dependency-text): Codex's "send a request to your admin or try again at 5:46 PM", Cursor's "try again at 3:38 PM".
const AT_CLOCK = /\b(?:try\s+again|resets?|available\s+again)\s+(?:at|after)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?![\d:])/i;

// "try again at Oct 16th, 2026 12:54 AM": Codex's wording for a reset on another day than today, the same wall clock
// with its date. Read by nothing before, so a team credit refused at 21:29 to reopen at 00:54 was filed with no reset,
// and as an allowance no reading measures it stood a week (2026-10-15).
// allow(dependency-text): Codex's "send a request to your admin or try again at Oct 16th, 2026 12:54 AM".
const AT_DATE =
    /\b(?:try\s+again|resets?|available\s+again)\s+(?:at|after|on)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?![\d:])/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// The clock a vendor's loop on this machine writes its reset on: its process is this one's child and inherits this
// one's zone, as the CLI's prompt date does (conversation-state.ts cliZone). A UTC container's, unless TZ says otherwise.
const loopZone = (): Zone => localZone();

// "resets at 2026-10-24T10:00:00Z": an instant written out whole.
const AT_INSTANT =
    /\b(?:try\s+again|resets?|available\s+again)\s+(?:at|after|on)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i;

// A JSON body's own count: `"reset_seconds": 3600`, `"resets_in_seconds": 3600`.
const SECONDS_FIELD = /"(?:reset_seconds|resets_in_seconds|reset_after_seconds)"\s*:\s*(\d+(?:\.\d+)?)/;

const inRange = (seconds: number, nowSeconds: number): number | undefined =>
    seconds > nowSeconds && seconds - nowSeconds <= LONGEST_SECONDS ? Math.ceil(seconds) : undefined;

const countedSpan = (span: string): number =>
    [...span.matchAll(COUNTED)].reduce((sum, [, count, unit]) => sum + Number(count) * (UNIT_SECONDS.get((unit ?? "s").toLowerCase()) ?? 0), 0);

// An hour and minute as a 24-hour wall clock reads them, or undefined for one no clock shows. A bare "at 9" with no
// minutes and no meridiem is a count, not a clock.
const wallTime = (hourText: string, minuteText: string | undefined, meridiemText: string | undefined): readonly [number, number] | undefined => {
    const hour = Number(hourText);
    const minute = minuteText === undefined ? 0 : Number(minuteText);
    const meridiem = meridiemText?.toLowerCase().replaceAll(".", "");
    if (minute > 59 || (meridiem === undefined ? hour > 23 : hour < 1 || hour > 12) || (meridiem === undefined && minuteText === undefined)) {
        return undefined;
    }
    return [meridiem === undefined ? hour : (hour % 12) + (meridiem === "pm" ? 12 : 0), minute];
};

// The next time the loop's clock reads this hour and minute, today or tomorrow there, in epoch seconds. Tomorrow is the
// next calendar day on that clock, not twenty-four hours on, so a night that changes the clocks still lands as said.
const nextClock = (match: RegExpExecArray, now: number, zone: Zone): number | undefined => {
    const time = wallTime(match[1] ?? "", match[2], match[3]);
    if (time === undefined) {
        return undefined;
    }
    const today = wallClockInstant(civilDayIn(now, zone), time[0], time[1], zone);
    return (today > now ? today : wallClockInstant(civilDayIn(nextDayStartIn(now, zone), zone), time[0], time[1], zone)) / 1000;
};

// A calendar day as `YYYY-MM-DD`, or undefined for one no calendar holds: "Oct 32nd" is a misread, not November 1st.
const calendarDay = (year: number, month: number, day: number): CivilDay | undefined => {
    const probe = Date.UTC(year, month, day);
    const utcDay = utcDayOf(probe);
    return utcDay === `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` ? utcDay : undefined;
};

// The dated wall clock a sentence names on the loop's clock, in epoch seconds; with no year, this one there, or the
// next once that is past.
const datedClock = (match: RegExpExecArray, now: number, zone: Zone): number | undefined => {
    const month = MONTHS.indexOf((match[1] ?? "").toLowerCase());
    const time = wallTime(match[4] ?? "", match[5], match[6]);
    if (month === -1 || time === undefined) {
        return undefined;
    }
    const named = match[3] === undefined ? undefined : Number(match[3]);
    const year = named ?? Number(civilDayIn(now, zone).slice(0, 4));
    const at = (inYear: number): number | undefined => {
        const day = calendarDay(inYear, month, Number(match[2]));
        return day === undefined ? undefined : wallClockInstant(day, time[0], time[1], zone);
    };
    const instant = at(year);
    const chosen = named === undefined && instant !== undefined && instant <= now ? at(year + 1) : instant;
    return chosen === undefined ? undefined : chosen / 1000;
};

/**
 * When the vendor's sentence says the allowance reopens, in epoch seconds; undefined when it names no instant, or one
 * in the past or further off than any plan's cycle. Read first: "Resets in …", a written instant, a dated wall clock, a
 * time of day, then a JSON body's own seconds field. A wall clock is read on `zone`, the clock the loop wrote it on.
 */
export const namedReset = (message: string, now: number = Date.now(), zone: Zone = loopZone()): number | undefined => {
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
    const dated = AT_DATE.exec(message);
    const atDate = dated === null ? undefined : datedClock(dated, now, zone);
    if (atDate !== undefined) {
        return inRange(atDate, nowSeconds);
    }
    const clock = AT_CLOCK.exec(message);
    const atClock = clock === null ? undefined : nextClock(clock, now, zone);
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

import { ref } from "vue";

// Human-readable byte size for the breadcrumb / file-info chips. Empty string when the size is unknown.
export const formatBytes = (bytes: number | undefined): string => {
    if (bytes === undefined) {
        return ``;
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = [`KB`, `MB`, `GB`, `TB`];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    // The unit symbols stay as they are: KB/MB/GB are read as symbols rather than words in every language we ship.
    return `${value < 10 ? formatFixed(value, 1) : formatFixed(Math.round(value), 0)} ${units[unit]}`;
};

// A span of playable seconds as a clock, hours omitted under an hour ("0:14", "3:07:22"). Infinity or NaN render
// `--:--` rather than "0:00": a container that hasn't reported its length yet is not a zero-length one.
export const formatDuration = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return `--:--`;
    }
    const whole = Math.floor(seconds);
    const pad = (value: number): string => String(value).padStart(2, `0`);
    const hours = Math.floor(whole / 3600);
    return hours > 0 ? `${hours}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}` : `${Math.floor(whole / 60)}:${pad(whole % 60)}`;
};

// Token counts at chip width: "1.4M" past a million, "142k" past a thousand, exact below that. Used everywhere
// tokens are quoted so two surfaces never disagree.
export const formatTokens = (tokens: number): string =>
    tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);

// Two-letter monogram, the fallback after a picture, logo or glyph. Splits on the separators a name, email or repo
// uses ("John Doe"→JD); one word keeps its first two letters; empty input gives `undefined`.
export const initialsOf = (name: string): string | undefined => {
    const words = name.split(/[\s._@-]+/).filter((word) => word !== ``);
    const [first, second] = words;
    if (first === undefined) {
        return undefined;
    }
    return (second === undefined ? first.slice(0, 2) : `${first[0]}${second[0]}`).toUpperCase();
};

// Absolute dates always spell the month ("Jul 28, 2026"), never the ambiguous numeric default, and the 24-hour
// clock is the house style in every language — `hour12` stays pinned, since that is a design choice and not
// something a locale gets to answer. The timezone stays the viewer's own. Everything else follows the language the
// app is in: `setFormatLocale` below is called by the i18n layer, in the same tick the visible language changes.
const DATE_STYLES = {
    date: { year: `numeric`, month: `short`, day: `numeric` },
    // Spelled-out month, for the few places a date is a sentence rather than a column ("renews on October 1, 2026").
    dateLong: { year: `numeric`, month: `long`, day: `numeric` },
    dayMonth: { month: `short`, day: `numeric` },
    dateTime: { year: `numeric`, month: `short`, day: `numeric`, hour: `2-digit`, minute: `2-digit`, hour12: false },
    timestamp: { year: `numeric`, month: `short`, day: `numeric`, hour: `2-digit`, minute: `2-digit`, second: `2-digit`, hour12: false },
    time: { hour: `2-digit`, minute: `2-digit`, second: `2-digit`, hour12: false },
    clock: { hour: `2-digit`, minute: `2-digit`, hour12: false },
    weekdayTime: { weekday: `short`, hour: `2-digit`, minute: `2-digit`, hour12: false },
    dayMonthTime: { month: `short`, day: `numeric`, hour: `2-digit`, minute: `2-digit`, hour12: false },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

type DateStyle = keyof typeof DATE_STYLES;

// A REF, NOT A PLAIN VARIABLE, and that is the whole reason a language change reaches the dates already on screen.
// Every formatter below reads it on every call, so a render that formats a date takes a dependency on the language
// and re-runs when it moves. As a plain variable this changed what the NEXT call returned and told Vue nothing: the
// words swapped (vue-i18n's `t` reads a ref of its own) while every date, clock and byte count beside them stayed in
// the language before, until something unrelated happened to re-render it.
const formatLocale = ref(`en`);

// Built on first use and kept, since constructing an Intl formatter is expensive and these run per row; cleared
// wholesale when the language changes, which happens at most once per reader per session.
const dateFormats = new Map<DateStyle, Intl.DateTimeFormat>();
const relativeFormats = new Map<Intl.RelativeTimeFormatNumeric, Intl.RelativeTimeFormat>();
const numberFormats = new Map<number, Intl.NumberFormat>();

// Half of Europe writes "1,4 MB". A decimal point is a language's answer, not a constant, so every number this
// module prints with a fraction goes through here.
// EVERY ONE OF THESE READS `.value` BEFORE THE CACHE, never only on a miss: the read is what the calling render
// subscribes to, and a cache hit that skipped it would leave that render tracking nothing.
const formatFixed = (value: number, digits: number): string => {
    const locale = formatLocale.value;
    let format = numberFormats.get(digits);
    if (format === undefined) {
        format = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
        numberFormats.set(digits, format);
    }
    return format.format(value);
};

const dateFormat = (style: DateStyle): Intl.DateTimeFormat => {
    const locale = formatLocale.value;
    const had = dateFormats.get(style);
    if (had !== undefined) {
        return had;
    }
    const built = new Intl.DateTimeFormat(locale, DATE_STYLES[style]);
    dateFormats.set(style, built);
    return built;
};

const relativeFormat = (numeric: Intl.RelativeTimeFormatNumeric): Intl.RelativeTimeFormat => {
    const locale = formatLocale.value;
    const had = relativeFormats.get(numeric);
    if (had !== undefined) {
        return had;
    }
    // `narrow` is what keeps these chip-width ("5m ago", "vor 3 Std.", "2 dni temu") rather than sentence-width;
    // French is the one language whose narrow form CLDR spells as a signed number ("-5 min"), which reads fine in
    // a timestamp column and is not worth a per-language exception to avoid.
    const built = new Intl.RelativeTimeFormat(locale, { style: `narrow`, numeric });
    relativeFormats.set(numeric, built);
    return built;
};

/**
 * Points every formatter in this module at a language. Called only by the i18n layer — app code changes the
 * language through `setLocale`, which drives this so dates and text can never be in two different languages.
 *
 * Caches are dropped BEFORE the ref moves: the assignment is what wakes every render that formats something, and
 * a render woken while the old formatters were still cached would redraw the new language's date in the old one.
 */
export const setFormatLocale = (tag: string): void => {
    if (tag === formatLocale.value) {
        return;
    }
    dateFormats.clear();
    relativeFormats.clear();
    numberFormats.clear();
    formatLocale.value = tag;
};

/** A calendar day on its own: "Jul 28, 2026". */
export const formatDate = (at: number): string => dateFormat(`date`).format(at);

/**
 * A calendar day written out: "July 28, 2026". For prose — "renews on", "ends on" — where an abbreviated month reads
 * as a table cell. TAKES AN INSTANT, like every formatter here: a `YYYY-MM-DD` handed to `new Date()` is UTC midnight,
 * which renders as the previous day for every reader behind UTC.
 */
export const formatDateLong = (at: number | string): string => dateFormat(`dateLong`).format(new Date(at));

/** A day where the year is already implied by its surroundings: "Jul 28". */
export const formatDayMonth = (at: number): string => dateFormat(`dayMonth`).format(at);

/** Day and wall-clock minute: "Jul 28, 2026, 15:45". The default for a visible "when" label. */
export const formatDateTime = (at: number): string => dateFormat(`dateTime`).format(at);

/** The exact moment, seconds included: "Jul 28, 2026, 15:45:12". For `title` tooltips behind a coarser label. */
export const formatTimestamp = (at: number): string => dateFormat(`timestamp`).format(at);

/** Clock time alone, for rows already grouped under a day: "15:45:12". */
export const formatTime = (at: number): string => dateFormat(`time`).format(at);

// Wall-clock minute alone: "15:45". The narrowest "when" label, for a row that states the day separately (e.g.
// the chat transcript's per-prompt stamp).
export const formatClock = (at: number): string => dateFormat(`clock`).format(at);

/** A weekday and time, for instants within the coming week: "Tue 15:45". */
export const formatWeekdayTime = (at: number): string => dateFormat(`weekdayTime`).format(at);

/** A day and time with the year left to context: "Oct 20, 11:59". For instants past the coming week. */
export const formatDayMonthTime = (at: number): string => dateFormat(`dayMonthTime`).format(at);

// A weekday names an instant only while there is one of it ahead; past that "Tue" is a month away and reads as two
// days. Seven days, not six: a reset exactly a week out is the next same-named day, which the weekday alone can't
// separate from today.
const WEEKDAY_HORIZON_MS = 7 * 24 * 60 * 60_000;

/**
 * An instant a reader has to act on: the weekday inside the coming week, the date beyond it. One function, because
 * the two spellings are only correct over their own ranges and a caller holding an epoch can't be asked to know which.
 */
export const formatWhen = (at: number, now: number = Date.now()): string =>
    at - now < WEEKDAY_HORIZON_MS ? formatWeekdayTime(at) : formatDayMonthTime(at);

// Coarse relative time ("now", "5m ago", "3h ago"), always rounded down since an age is a floor. `days` switches
// the day-and-beyond case between a rolling "2d ago" and the absolute timestamp; `now` is injectable for tests.
// The wording is CLDR's, not ours: these phrases are the one part of the interface no translator has to supply,
// and getting Polish's four plural forms right by hand is precisely the trap `Intl` exists to close.
export const timeAgo = (at: number, { now = Date.now(), days = false }: { now?: number; days?: boolean } = {}): string => {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) {
        // `auto` is what turns a bare zero into a word ("now", "teraz", "jetzt") instead of "in 0s".
        return relativeFormat(`auto`).format(0, `second`);
    }
    if (minutes < 60) {
        return relativeFormat(`always`).format(-minutes, `minute`);
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return relativeFormat(`always`).format(-hours, `hour`);
    }
    return days ? relativeFormat(`always`).format(-Math.floor(hours / 24), `day`) : formatDateTime(at);
};

// Relative time under a day old, else a bare calendar day rather than `timeAgo`'s full absolute fallback, which
// would set the width of every row. Pair with the exact moment in a `title`.
export const freshness = (at: number): string => (Date.now() - at < 86_400_000 ? timeAgo(at) : formatDate(at));

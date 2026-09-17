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
    return hours > 0
        ? `${hours}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`
        : `${Math.floor(whole / 60)}:${pad(whole % 60)}`;
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
    dayMonth: { month: `short`, day: `numeric` },
    dateTime: { year: `numeric`, month: `short`, day: `numeric`, hour: `2-digit`, minute: `2-digit`, hour12: false },
    timestamp: { year: `numeric`, month: `short`, day: `numeric`, hour: `2-digit`, minute: `2-digit`, second: `2-digit`, hour12: false },
    time: { hour: `2-digit`, minute: `2-digit`, second: `2-digit`, hour12: false },
    clock: { hour: `2-digit`, minute: `2-digit`, hour12: false },
    weekdayTime: { weekday: `short`, hour: `2-digit`, minute: `2-digit`, hour12: false },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

type DateStyle = keyof typeof DATE_STYLES;

let formatLocale = `en`;

// Built on first use and kept, since constructing an Intl formatter is expensive and these run per row; cleared
// wholesale when the language changes, which happens at most once per reader per session.
const dateFormats = new Map<DateStyle, Intl.DateTimeFormat>();
const relativeFormats = new Map<Intl.RelativeTimeFormatNumeric, Intl.RelativeTimeFormat>();
const numberFormats = new Map<number, Intl.NumberFormat>();

// Half of Europe writes "1,4 MB". A decimal point is a language's answer, not a constant, so every number this
// module prints with a fraction goes through here.
const formatFixed = (value: number, digits: number): string => {
    let format = numberFormats.get(digits);
    if (format === undefined) {
        format = new Intl.NumberFormat(formatLocale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
        numberFormats.set(digits, format);
    }
    return format.format(value);
};

const dateFormat = (style: DateStyle): Intl.DateTimeFormat => {
    const had = dateFormats.get(style);
    if (had !== undefined) {
        return had;
    }
    const built = new Intl.DateTimeFormat(formatLocale, DATE_STYLES[style]);
    dateFormats.set(style, built);
    return built;
};

const relativeFormat = (numeric: Intl.RelativeTimeFormatNumeric): Intl.RelativeTimeFormat => {
    const had = relativeFormats.get(numeric);
    if (had !== undefined) {
        return had;
    }
    // `narrow` is what keeps these chip-width ("5m ago", "vor 3 Std.", "2 dni temu") rather than sentence-width;
    // French is the one language whose narrow form CLDR spells as a signed number ("-5 min"), which reads fine in
    // a timestamp column and is not worth a per-language exception to avoid.
    const built = new Intl.RelativeTimeFormat(formatLocale, { style: `narrow`, numeric });
    relativeFormats.set(numeric, built);
    return built;
};

/**
 * Points every formatter in this module at a language. Called only by the i18n layer — app code changes the
 * language through `setLocale`, which drives this so dates and text can never be in two different languages.
 */
export const setFormatLocale = (tag: string): void => {
    if (tag === formatLocale) {
        return;
    }
    formatLocale = tag;
    dateFormats.clear();
    relativeFormats.clear();
    numberFormats.clear();
};

/** A calendar day on its own: "Jul 28, 2026". */
export const formatDate = (at: number): string => dateFormat(`date`).format(at);

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

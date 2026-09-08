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
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
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

// Absolute dates always spell the month ("Jul 28, 2026"), never the ambiguous numeric default. Locale and 24-hour
// format are pinned so the same instant renders identically everywhere; only the timezone stays the viewer's own.
// Formatters are built once, since constructing an Intl.DateTimeFormat is expensive.
const DATE = new Intl.DateTimeFormat(`en-US`, { year: `numeric`, month: `short`, day: `numeric` });
const DAY_MONTH = new Intl.DateTimeFormat(`en-US`, { month: `short`, day: `numeric` });
const DATE_TIME = new Intl.DateTimeFormat(`en-US`, {
    year: `numeric`,
    month: `short`,
    day: `numeric`,
    hour: `2-digit`,
    minute: `2-digit`,
    hour12: false,
});
const TIMESTAMP = new Intl.DateTimeFormat(`en-US`, {
    year: `numeric`,
    month: `short`,
    day: `numeric`,
    hour: `2-digit`,
    minute: `2-digit`,
    second: `2-digit`,
    hour12: false,
});
const TIME = new Intl.DateTimeFormat(`en-US`, { hour: `2-digit`, minute: `2-digit`, second: `2-digit`, hour12: false });
const CLOCK = new Intl.DateTimeFormat(`en-US`, { hour: `2-digit`, minute: `2-digit`, hour12: false });
const WEEKDAY_TIME = new Intl.DateTimeFormat(`en-US`, { weekday: `short`, hour: `2-digit`, minute: `2-digit`, hour12: false });

/** A calendar day on its own: "Jul 28, 2026". */
export const formatDate = (at: number): string => DATE.format(at);

/** A day where the year is already implied by its surroundings: "Jul 28". */
export const formatDayMonth = (at: number): string => DAY_MONTH.format(at);

/** Day and wall-clock minute: "Jul 28, 2026, 15:45". The default for a visible "when" label. */
export const formatDateTime = (at: number): string => DATE_TIME.format(at);

/** The exact moment, seconds included: "Jul 28, 2026, 15:45:12". For `title` tooltips behind a coarser label. */
export const formatTimestamp = (at: number): string => TIMESTAMP.format(at);

/** Clock time alone, for rows already grouped under a day: "15:45:12". */
export const formatTime = (at: number): string => TIME.format(at);

// Wall-clock minute alone: "15:45". The narrowest "when" label, for a row that states the day separately (e.g.
// the chat transcript's per-prompt stamp).
export const formatClock = (at: number): string => CLOCK.format(at);

/** A weekday and time, for instants within the coming week: "Tue 15:45". */
export const formatWeekdayTime = (at: number): string => WEEKDAY_TIME.format(at);

// Coarse relative time ("just now", "Nm ago", "Nh ago"), always rounded down since an age is a floor. `days`
// switches the day-and-beyond case between a rolling "Nd ago" and the absolute timestamp; `now` is injectable
// for tests.
export const timeAgo = (at: number, { now = Date.now(), days = false }: { now?: number; days?: boolean } = {}): string => {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) {
        return `just now`;
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    return days ? `${Math.floor(hours / 24)}d ago` : formatDateTime(at);
};

// Relative time under a day old, else a bare calendar day rather than `timeAgo`'s full absolute fallback, which
// would set the width of every row. Pair with the exact moment in a `title`.
export const freshness = (at: number): string => (Date.now() - at < 86_400_000 ? timeAgo(at) : formatDate(at));

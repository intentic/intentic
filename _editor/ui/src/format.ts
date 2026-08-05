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

// Token counts, at the width a chip or a summary line can spare: "1.4M" past a million, "142k" once thousands
// are reached, the exact number below that. The same rounding wherever tokens are quoted (context meter,
// per-account usage, cleaner savings, the fleet board's per-agent counts), so two surfaces quoting the same
// number never disagree about it — which is what a second copy in agentStatus.ts had quietly stopped being
// true: it carried the megabyte tier this one lacked, so a 1.5M-token agent read "1500k" on one screen and
// "1.5M" on the next.
export const formatTokens = (tokens: number): string =>
    tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);

/* A NAME, at the width of a small square — the monogram under every avatar and every brand mark, and the last
 * tier of both ladders: what is drawn for something that has no picture, no logo and no glyph.
 *
 * Splits on every separator a person's name, an email address, a repository and a `publisher.name` all use, so
 * the two letters are word-initials wherever there are words to take them from: "John Doe" → JD,
 * "ada.lovelace@example.com" → AL, "git-history" → GH. One word keeps its first two glyphs ("memory" → ME)
 * rather than doubling a letter. Undefined for a name with nothing in it, which is how a caller knows to draw
 * its neutral glyph instead of an empty plate.
 *
 * One rule, because the two copies this replaces had already drifted into two: the rail's split on `[-_\s]`
 * alone, so a dotted repository name gave its first two LETTERS where the same name gave its two INITIALS
 * three components away. */
export const initialsOf = (name: string): string | undefined => {
    const words = name.split(/[\s._@-]+/).filter((word) => word !== ``);
    const [first, second] = words;
    if (first === undefined) {
        return undefined;
    }
    return (second === undefined ? first.slice(0, 2) : `${first[0]}${second[0]}`).toUpperCase();
};

/* Every absolute date the app shows, in one shape: "Jul 28, 2026" — a spelled-out month, because the browser
 * default is numeric and order-ambiguous ("7/28/2026" to one reader, the 7th of August to the next), and no
 * row anywhere carries enough context to disambiguate it.
 *
 * The locale is pinned rather than followed for the same reason the clock is fixed at 24-hour: a screenshot, a
 * bug report, a test fixture and the person reading them should all quote the same string. The *timezone*
 * still isn't pinned — these render the viewer's own wall clock, which is the one thing they do want local.
 * `hour12: false` is the h23 cycle per ECMA-402, so midnight reads 00:05 and never 24:05.
 *
 * Formatters are built once here: constructing an Intl.DateTimeFormat is the expensive half of formatting, and
 * keeping them private is what stops a surface from quietly growing a seventh variant. */
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

/** A weekday and time, for instants within the coming week: "Tue 15:45". */
export const formatWeekdayTime = (at: number): string => WEEKDAY_TIME.format(at);

// Coarse "time since" for activity/log/history rows: "just now" under a minute, "Nm ago"/"Nh ago" within a
// day, else the absolute local timestamp. Distinct on purpose from chat's compact `relativeTime` (no "ago",
// adds a day tier) — different surfaces want different formats.
export const timeAgo = (at: number): string => {
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) {
        return `just now`;
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    if (minutes < 60 * 24) {
        return `${Math.round(minutes / 60)}h ago`;
    }
    return formatDateTime(at);
};

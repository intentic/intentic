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
 * keeping them private is what stops a surface from quietly growing a variant of its own. */
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

/* The wall-clock MINUTE alone: "15:45". The narrowest a "when" label gets, for a surface that has room for five
 * characters beside a row and states the day somewhere else — the chat transcript's per-prompt stamp, which
 * sits in the margin beside the bubble under a marker naming the day (see formatDate). Seconds are left to
 * formatTime: a message was sent at a minute, and the second it landed on is noise at four characters' cost. */
export const formatClock = (at: number): string => CLOCK.format(at);

/** A weekday and time, for instants within the coming week: "Tue 15:45". */
export const formatWeekdayTime = (at: number): string => WEEKDAY_TIME.format(at);

/* Coarse "time since": "just now" under a minute, then "Nm ago" and "Nh ago". PAST A DAY THE TWO CALLERS WANT
 * DIFFERENT THINGS, which is the whole of `days` — a log or history row wants the absolute local timestamp
 * (three days out, "Jul 28, 2026, 15:45" is the useful answer and "3d ago" is not), while a reading whose age is
 * the point ("measured 3d ago") wants to keep counting. One function with a switch rather than two functions:
 * the second one drifted on every tier BELOW the day — it rounded down where this rounded up and called two
 * minutes "just now" — so the same gap read differently on two screens that sit one click apart.
 *
 * IT ROUNDS DOWN, everywhere. An age is a floor — "1h ago" for something 119 minutes old is true and "2h ago"
 * is not, and for the usage readings this labels it is doubly so: utilization only climbs inside a window, so
 * the figure is already a lower bound and its age must not overstate how fresh it is.
 *
 * `now` is injectable for the callers that format a list against one clock (and for tests). Distinct on purpose
 * from chat's compact `relativeTime`, which drops the "ago" — different surfaces want different formats. */
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

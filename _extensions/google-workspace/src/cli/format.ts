/* HOW RESULTS ARE PRINTED WHEN `--json` IS NOT ASKED FOR.
 *
 * The reader is a language model paying for every token, so the default output is one line per thing, fields
 * separated by two spaces, ids first because an id is what the next command needs. No box drawing, no aligned
 * columns: alignment costs padding on every row and buys nothing to something reading the text rather than
 * scanning it.
 *
 * Nothing here truncates silently, `clip` marks what it removed, so a subject that got cut looks cut. */

export const clip = (value: string, width: number): string => {
    const flat = value.replaceAll(/\s+/g, " ").trim();
    return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
};

// An RFC-3339 timestamp as something a person reads, in the connection's own timezone as Google reported it.
// Deliberately not localized: a fixed shape is what makes a list of them scannable.
export const when = (value: string | undefined): string => {
    if (value === undefined || value === "") {
        return "—";
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        // An all-day calendar event carries a bare date; that IS the value, so it is passed through.
        return value;
    }
    return parsed.toISOString().replace("T", " ").slice(0, 16);
};

export const bytes = (size: number | undefined): string => {
    if (size === undefined || !Number.isFinite(size)) {
        return "—";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let scaled = size;
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? scaled : scaled.toFixed(1)}${units[unit]}`;
};

// One row: empty fields collapse rather than leaving a run of separators behind them.
export const row = (...fields: (string | undefined)[]): string => fields.filter((field) => field !== undefined && field !== "").join("  ");

// A short, greppable count line under a list. Says when a limit is what ended it, because "12 results" and
// "the first 12 of an unknown number" are different answers and only one of them means stop looking.
export const tally = (shown: number, limit: number, what: string): string =>
    shown >= limit ? `${shown} ${what} (the limit — pass -n for more)` : count(shown, what);

// The same line where nothing was capped: a whole thread, one message's attachments.
export const count = (shown: number, what: string): string => (shown === 0 ? `no ${what}` : `${shown} ${what}`);

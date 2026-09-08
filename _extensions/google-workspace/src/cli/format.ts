// How results print when `--json` isn't asked for: one line per thing, fields separated by two spaces, ids first since
// an id is what the next command needs. No box drawing or column alignment; `clip` marks what it truncated rather than
// cutting silently.

export const clip = (value: string, width: number): string => {
    const flat = value.replaceAll(/\s+/g, " ").trim();
    return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
};

// An RFC-3339 timestamp as something a person reads, in the connection's own timezone as Google reported it. Not
// localized: a fixed shape keeps a list of them scannable.
export const when = (value: string | undefined): string => {
    if (value === undefined || value === "") {
        return "—";
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        // An all-day calendar event carries a bare date; that is the value, so it passes through unchanged.
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

// A short count line under a list; says when a limit ended it, since "12 results" and "the first 12 of an unknown
// number" mean different things.
export const tally = (shown: number, limit: number, what: string): string =>
    shown >= limit ? `${shown} ${what} (the limit, pass -n for more)` : count(shown, what);

// The same line where nothing was capped: a whole thread, one message's attachments.
export const count = (shown: number, what: string): string => (shown === 0 ? `no ${what}` : `${shown} ${what}`);

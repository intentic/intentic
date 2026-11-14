// How long a pool's window runs, read off the provider's own key and whatever name it published. One implementation,
// because two things need it and must agree: a narrow column names the window by `short`, and a reading with no
// published reset instant may only be trusted for `seconds` past the moment it was taken.

export interface WindowPeriod {
    readonly seconds: number;
    // The token a narrow column names this window by, e.g. "5h", "wk".
    readonly short: string;
}

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;

/** Kind and label as space-padded lowercase words, underscores split, so `\b` matches across both spellings. */
export const periodWords = (pool: { readonly kind: string; readonly label?: string | undefined }): string =>
    ` ${`${pool.kind} ${pool.label ?? ""}`
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/gu, " ")
        .trim()} `;

// A count the words spell out, e.g. the 3 in "3 days".
const counted = (words: string, pattern: RegExp): number | undefined => {
    const found = pattern.exec(words)?.[1];
    return found === undefined ? undefined : Number(found);
};

// Day-scale and longer, where the named periods outrank a bare count: "7 days" is the week every plan sells, not a
// seven-day span of its own.
const dayPeriod = (words: string, days: number | undefined): WindowPeriod | undefined => {
    if (days === 7 || /\bseven days?\b|\bweek(ly|s)?\b/u.test(words)) {
        return { seconds: 7 * DAY_SECONDS, short: "wk" };
    }
    if (/\bmonth(ly|s)?\b/u.test(words)) {
        return { seconds: 30 * DAY_SECONDS, short: "mo" };
    }
    if (days === 1 || /\bdaily\b/u.test(words)) {
        return { seconds: DAY_SECONDS, short: "24h" };
    }
    return days === undefined ? undefined : { seconds: days * DAY_SECONDS, short: `${days}d` };
};

/** Window length behind a pool; undefined when neither the key nor the name says how long it runs. */
export const windowPeriod = (pool: { readonly kind: string; readonly label?: string | undefined }): WindowPeriod | undefined => {
    const words = periodWords(pool);
    const hours = counted(words, /\b(\d+) hours?\b/u);
    // Hours first: a pool named both ("5 hours, weekly cap") runs on the shorter clock.
    if (hours !== undefined || /\bfive hours?\b/u.test(words)) {
        const span = hours ?? 5;
        return { seconds: span * HOUR_SECONDS, short: `${span}h` };
    }
    const day = dayPeriod(words, counted(words, /\b(\d+) days?\b/u));
    if (day !== undefined) {
        return day;
    }
    const minutes = counted(words, /\b(\d+) minutes?\b/u);
    return minutes === undefined ? undefined : { seconds: minutes * 60, short: `${minutes}m` };
};

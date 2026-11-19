// How long a pool's window runs. One implementation, because two things need it and must agree: a narrow column names
// the window by `short`, and a reading with no published reset instant may only be trusted for `seconds` past the moment
// it was taken.
//
// The reader that parsed the provider's answer states the length where the answer says it (`periodSeconds`), and that
// statement is what every judgement reads. Before 2026-11-19 the length was worked out again on every judgement, in the
// daemon and in every open window, from the words of the pool's key and name ("5 hours", "weekly", "seven days"), and
// those words are still how a window filed without a statement is read: every reading before then, and a pool whose
// answer states nothing but whose name does. Re-reading the words each time was rejected, since a fact the provider gave
// once had to be recovered from a label on every judgement, and a pool named without period words (a Claude model's
// weekly slice, "Fable") read as having no length at all.

export interface WindowPeriod {
    readonly seconds: number;
    // The token a narrow column names this window by, e.g. "5h", "wk".
    readonly short: string;
}

/** What a period is read off: the pool's key and name, and the length its reader stated, where it stated one. */
export interface PeriodSource {
    readonly kind: string;
    readonly label?: string | undefined;
    readonly periodSeconds?: number | undefined;
}

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
// A month as the plans sell it: ChatGPT states its monthly window as 30 days, and a calendar month runs 28 to 31.
const MONTH_DAYS = { least: 28, most: 31 } as const;

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

/**
 * Window length the words of a key and a name spell out; undefined where they name none. What a reader with a word for
 * the period and no figure states (Google's bucket `window: "weekly"`), and what a window with no statement is read by.
 */
export const namedPeriod = (pool: { readonly kind: string; readonly label?: string | undefined }): WindowPeriod | undefined => {
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
    return minutes === undefined ? undefined : { seconds: minutes * MINUTE_SECONDS, short: `${minutes}m` };
};

// A stated length, named as the words would name it: the week, a day as "24h", a month, else whole days, hours or
// minutes, and seconds only for a length none of those divides.
const statedPeriod = (seconds: number): WindowPeriod => {
    const days = seconds / DAY_SECONDS;
    if (Number.isInteger(days)) {
        if (days === 7) {
            return { seconds, short: "wk" };
        }
        if (days === 1) {
            return { seconds, short: "24h" };
        }
        return { seconds, short: days >= MONTH_DAYS.least && days <= MONTH_DAYS.most ? "mo" : `${days}d` };
    }
    if (Number.isInteger(seconds / HOUR_SECONDS)) {
        return { seconds, short: `${seconds / HOUR_SECONDS}h` };
    }
    return { seconds, short: Number.isInteger(seconds / MINUTE_SECONDS) ? `${seconds / MINUTE_SECONDS}m` : `${seconds}s` };
};

/**
 * Window length behind a pool: the one its reader stated (`periodSeconds`), else the one its key and name spell out
 * (namedPeriod); undefined where neither says how long it runs.
 */
export const windowPeriod = (pool: PeriodSource): WindowPeriod | undefined =>
    pool.periodSeconds !== undefined && pool.periodSeconds > 0 ? statedPeriod(pool.periodSeconds) : namedPeriod(pool);

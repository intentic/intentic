import type { LocalRecent } from "./desktop";

// What Home decides without drawing anything: which recents it lists, how it says when each was opened, and whether
// this machine's own sandboxes are any of its business. Pure, so each decision is tested by value (home.test.ts).

/* THE RECENTS. */

// How many recents Home lists, which is as many as the app keeps (state.rs `RECENTS`), and past how many a filter
// earns its line: six rows are read at a glance, a dozen are searched.
export const RECENTS_SHOWN = 12;
export const FILTER_AFTER = 6;

// The first instant a number can be milliseconds rather than seconds: 1e11 seconds is the year 5138, while
// milliseconds passed it in 1973.
const MILLISECONDS_FROM = 1e11;
const fromEpoch = (value: number): number => (value < MILLISECONDS_FROM ? value * 1000 : value);

/** When a recent was opened, in epoch ms; undefined when the app could not say (a zero, a clock before 1970). */
export const openedAtMs = (openedAt: number | string): number | undefined => {
    // A number stays itself and a numeral reads as one; an ISO instant is not a number, so it is read as a date.
    const numeric = Number(openedAt);
    const at = Number.isFinite(numeric) ? fromEpoch(numeric) : Date.parse(String(openedAt));
    return Number.isFinite(at) && at > 0 ? at : undefined;
};

// How long ago, in the few words a list row has room for. A calendar date past yesterday, since "9 days ago" makes
// the reader do the arithmetic the date already did.
export type RecentWhen =
    | { readonly kind: `justNow` }
    | { readonly kind: `minutes`; readonly count: number }
    | { readonly kind: `hours`; readonly count: number }
    | { readonly kind: `yesterday` }
    | { readonly kind: `date`; readonly at: number; readonly thisYear: boolean };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// The reader's own calendar day, on their own clock: the app and the reader are the same machine.
const sameDay = (one: Date, other: Date): boolean =>
    one.getFullYear() === other.getFullYear() && one.getMonth() === other.getMonth() && one.getDate() === other.getDate();

/**
 * `at` as seen from `now`, both epoch ms. Rounded down, since an age is a floor. An instant ahead of `now` (a clock
 * that moved back) is "just now" rather than a negative age. "Yesterday" is the calendar's, so it is only said past
 * 24 hours, where the hours would stop being a small number.
 */
export const recentWhen = (at: number, now: number): RecentWhen => {
    const age = now - at;
    if (age < MINUTE_MS) {
        return { kind: `justNow` };
    }
    if (age < HOUR_MS) {
        return { kind: `minutes`, count: Math.floor(age / MINUTE_MS) };
    }
    if (age < DAY_MS) {
        return { kind: `hours`, count: Math.floor(age / HOUR_MS) };
    }
    const then = new Date(at);
    const today = new Date(now);
    if (sameDay(then, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) {
        return { kind: `yesterday` };
    }
    return { kind: `date`, at, thisYear: then.getFullYear() === today.getFullYear() };
};

const SEPARATORS = /[\\/]/;

/** The recent as the reader recognises it: its own name. A drive or the root is its own name. */
export const nameOf = (path: string): string => path.split(SEPARATORS).findLast((part) => part !== ``) ?? path;

/** The folder it is in, as written: `/home/ada` for `/home/ada/Taxes`, `C:\` for `C:\notes.md`, nothing for a root. */
export const whereOf = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/, ``);
    const cut = Math.max(trimmed.lastIndexOf(`/`), trimmed.lastIndexOf(`\\`));
    if (cut < 0) {
        return ``;
    }
    // A child of the root or of a drive keeps its separator: `/`, `C:\`, never an empty string or a bare `C:`.
    const parent = trimmed.slice(0, cut);
    return parent === `` || /^[A-Za-z]:$/.test(parent) ? trimmed.slice(0, cut + 1) : parent;
};

// Either separator, so a query typed with `/` finds a Windows path and one typed with `\` a POSIX one.
const comparable = (text: string): string => text.toLowerCase().replaceAll(`\\`, `/`);

/** The recents whose path holds every word of `query`, anywhere in the name or the folder, in the order given. */
export const filterRecents = <Recent extends Pick<LocalRecent, `path`>>(recents: readonly Recent[], query: string): Recent[] => {
    const words = comparable(query).split(/\s+/).filter((word) => word !== ``);
    return recents.filter((recent) => {
        const path = comparable(recent.path);
        return words.every((word) => path.includes(word));
    });
};

/** The rows Home draws, and whether it offers the filter to narrow them. */
export interface RecentRows<Recent> {
    readonly rows: Recent[];
    readonly filterable: boolean;
}

/** Only while the filter is on screen does a query narrow anything: one left over from a longer list hides nothing. */
export const recentRows = <Recent extends Pick<LocalRecent, `path`>>(recents: readonly Recent[], query: string): RecentRows<Recent> => {
    const listed = recents.slice(0, RECENTS_SHOWN);
    const filterable = listed.length > FILTER_AFTER;
    return { rows: filterable ? filterRecents(listed, query) : listed, filterable };
};

/* THIS DEVICE. */

// What says this machine's sandboxes are the reader's business. Nothing here is about Docker being up or down: a
// Docker that is off on a machine nobody runs a sandbox on is nobody's problem, and saying so was the nag this face
// used to open on.
export interface DeviceSigns {
    // A sandbox has been set up here (home_facts).
    readonly hostsSandboxes: boolean;
    // Sandboxes `ic` lists here now.
    readonly sandboxes: number;
    // The machine agent answered, or is installed and failed to.
    readonly agent: boolean;
    // A setup, a sync enrollment, a sandbox's own run or a Docker start this window is running or reporting on.
    readonly inFlight: boolean;
}

/** Whether Home shows the "This device" block: any one sign is enough, and a files-only machine has none. */
export const deviceShown = (signs: DeviceSigns): boolean => signs.hostsSandboxes || signs.sandboxes > 0 || signs.agent || signs.inFlight;

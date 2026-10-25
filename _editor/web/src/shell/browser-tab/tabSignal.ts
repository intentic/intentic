// Pure tab signal data; browserTab.ts/chimes.ts own DOM/sound. Title changes only for actionable news; the icon may also show work quietly.
// Priority: asks (same count as Agents), offline (lower states no longer reliable), done (finished while away, cleared on return), working.
// Working is icon-only, avoiding background-title alerts for every turn transition.

import type { SandboxAvailability } from "../../features/sandbox/overview/availability";

export type TabMark =
    | { readonly kind: `asks`; readonly count: number }
    | { readonly kind: `offline` }
    | { readonly kind: `done` }
    | { readonly kind: `working` };

export interface TabFacts {
    readonly asks: number;
    readonly offline: boolean;
    readonly doneAway: boolean;
    readonly working: boolean;
}

export const tabMark = (facts: TabFacts): TabMark | undefined => {
    if (facts.asks > 0) {
        return { kind: `asks`, count: facts.asks };
    }
    if (facts.offline) {
        return { kind: `offline` };
    }
    if (facts.doneAway) {
        return { kind: `done` };
    }
    return facts.working ? { kind: `working` } : undefined;
};

// Past the half minute a reconnect is given in silence (availability.ts), and every ending that waiting will not mend.
// Not `busy`: a sandbox the diagnosis saw alive is catching up, and a tab that said "Offline" over it was the loudest
// false alarm the app had.
const OFFLINE: ReadonlySet<SandboxAvailability> = new Set([`unreachable`, `detached`, `removed`, `blocked`]);

// Whether the tab says the sandbox is offline. `seen`: it has answered before, in this tab or anywhere (its row's last
// announce). One that never has is still being set up, not offline: /setup's tab read "Offline" twenty seconds into a
// first install (2026-10-12), over a sandbox whose edge had no tunnel yet because nothing had started. Its removal is a
// fact rather than a silence, and is still said.
export const tabOffline = (availability: SandboxAvailability, seen: boolean): boolean =>
    OFFLINE.has(availability) && (seen || availability === `removed`);

// The title a page gets with no mark: `<Page> / intentic`, or the bare brand on a route that names nothing.
export const pageTitle = (page: string | undefined): string => (page === undefined ? `intentic` : `${page} / intentic`);

// The mark goes first, since a narrow tab shows only the start of its title. `(2)` is the count every mail and chat app
// puts there, read without a legend. `offline` is a word, not a glyph: it is rare, and no glyph says it unambiguously.
export const tabTitle = (page: string | undefined, mark: TabMark | undefined, offline: string): string => {
    const title = pageTitle(page);
    switch (mark?.kind) {
        case `asks`:
            return `(${mark.count}) ${title}`;
        case `done`:
            return `✓ ${title}`;
        case `offline`:
            return `${offline} · ${title}`;
        default:
            return title;
    }
};

// One reading of the fleet, for telling news from what was already there. Keys are qualified by sandbox, so switching
// to another one never reads as its agents finishing or asking.
export interface TabFrame {
    // What calls the reader, per source (one sandbox's roster, or its held wakes). Only a source present in both
    // readings can bring news: its first read, and a sandbox the reader just switched to, set a baseline instead.
    readonly asks: ReadonlyMap<string, ReadonlySet<string>>;
    // Turns someone started that are running now, and those that have settled in Finished.
    readonly working: ReadonlySet<string>;
    readonly settled: ReadonlySet<string>;
}

export interface TabNews {
    // Something new calls the reader.
    readonly asked: boolean;
    // How many turns went from running to Finished between the two readings.
    readonly finished: number;
}

export const NO_NEWS: TabNews = { asked: false, finished: 0 };

// The same news by name, for what tells it one item at a time (a desktop notification per ask, desktopSignal.ts).
export interface NewsItems {
    // Each new caller, with the source that reads it (a sandbox's roster, or `<sandbox>#held`).
    readonly asked: readonly { readonly source: string; readonly key: string }[];
    // Each turn that went from running to Finished, by its frame key (`<sandbox>/<agent>`).
    readonly finished: readonly string[];
}

export const NO_ITEMS: NewsItems = { asked: [], finished: [] };

export const newsItemsBetween = (before: TabFrame | undefined, after: TabFrame): NewsItems => {
    if (before === undefined) {
        return NO_ITEMS;
    }
    const asked: { readonly source: string; readonly key: string }[] = [];
    for (const [source, keys] of after.asks) {
        const known = before.asks.get(source);
        if (known !== undefined) {
            asked.push(...[...keys].filter((key) => !known.has(key)).map((key) => ({ source, key })));
        }
    }
    return { asked, finished: [...before.working].filter((key) => after.settled.has(key)) };
};

export const newsBetween = (before: TabFrame | undefined, after: TabFrame): TabNews => {
    const items = newsItemsBetween(before, after);
    return { asked: items.asked.length > 0, finished: items.finished.length };
};

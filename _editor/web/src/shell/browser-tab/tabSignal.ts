// What the browser tab says about this workspace while the reader is looking at something else: the one surface of the
// app that stays in sight from another tab, another window or a pinned tab. Pure functions over plain data; the DOM
// and the sound live in browserTab.ts and chimes.ts.
//
// Two channels, split by what a change costs the reader:
// - The TITLE changes only for news the reader should act on. A browser marks a background tab whose title changed
//   (Chrome dots a pinned one), so a title that flipped every time a turn started or ended would cry wolf all day.
// - The ICON carries the same marks and one more, work under way: it changes quietly, and it is all a pinned tab or a
//   crowded tab strip has room to show.
//
// One mark at a time, the first of these that holds:
// 1. `asks`: something needs you, counted as the Agents tile counts it, so the tab and the rail never disagree.
// 2. `offline`: the sandbox is not answering, so nothing below this line is true any more.
// 3. `done`: a turn someone started finished while the reader was away; gone the moment they are back.
// 4. `working`: a turn is running. Icon only.

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

export const newsBetween = (before: TabFrame | undefined, after: TabFrame): TabNews => {
    if (before === undefined) {
        return NO_NEWS;
    }
    let asked = false;
    for (const [source, keys] of after.asks) {
        const known = before.asks.get(source);
        if (known !== undefined && [...keys].some((key) => !known.has(key))) {
            asked = true;
            break;
        }
    }
    const finished = [...before.working].filter((key) => after.settled.has(key)).length;
    return { asked, finished };
};

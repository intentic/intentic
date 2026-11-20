import { randomUUID } from "node:crypto";
import {
    type BrowsingEntry,
    type BrowsingForget,
    type BrowsingHistory,
    type BrowsingTerm,
    SEARCH_ENGINE_INFO,
} from "@intentic/sandbox-contract/schemas/browsing";
import { opt } from "../../opt.js";

// One browser profile's history as the address bar wants it: a page per address with how often and how lately it was
// visited (typed visits apart), and the searches made. Pure and in memory; browsing-store.ts loads and saves it, and the
// feed (browsing-feed.ts) and Chromium's own History (chromium-history.ts) fill it.
//
// Every change bumps `rev`, and each page and term carries the rev it last changed at, so a caller holding an earlier
// answer is told only what moved since (`read` with its cursor). Forgetting by address leaves a tombstone for the same
// reason; forgetting a stretch of time or everything mints a new generation instead, which every older cursor misses,
// so their holders are sent the whole index again.

// How a visit arrived, from Chromium's page transition (chromium-history.ts and browsing-feed.ts both map to this).
export type VisitKind = "typed" | "link" | "reload" | "redirect";

export interface RecentVisit {
    readonly at: number;
    readonly typed?: boolean | undefined;
}

export interface IndexEntry {
    readonly url: string;
    title: string | undefined;
    visits: number;
    typed: number;
    last: number;
    // The newest visits, newest first: what frecency is computed from, and what a forgotten stretch of time takes out.
    recent: RecentVisit[];
    rev: number;
}

export interface IndexTerm {
    readonly term: string;
    count: number;
    last: number;
    rev: number;
}

// What the store saves and loads, without the revisions, which only mean something within one daemon's life.
export interface IndexFile {
    seeded: boolean;
    entries: { url: string; title?: string | undefined; visits: number; typed: number; last: number; recent: RecentVisit[] }[];
    terms: { term: string; count: number; last: number }[];
}

// Firefox's frecency, simplified: the visit count times the average worth of the newest few visits, a visit's worth
// falling with its age and doubled when it was typed.
const RECENT_KEPT = 10;
const DAY_MS = 86_400_000;
const AGE_POINTS: readonly (readonly [number, number])[] = [
    [4 * DAY_MS, 100],
    [14 * DAY_MS, 70],
    [31 * DAY_MS, 50],
    [90 * DAY_MS, 30],
];
const OLD_POINTS = 10;
const TYPED_FACTOR = 2;

// Beyond this many pages the least worth suggesting go, so an agent's browser crawling a site cannot grow the file
// without bound. Far above the few thousand a full answer ships.
export const MAX_ENTRIES = 20_000;
const MAX_TERMS = 1000;
// Tombstones kept for callers catching up; one older than the oldest kept is sent the whole index instead.
const MAX_TOMBSTONES = 5000;
// What a full answer ships by default: enough to rank locally, small enough to send whole.
export const SNAPSHOT_LIMIT = 5000;
const TITLE_MAX = 500;
const URL_MAX = 4096;

const pointsFor = (age: number): number => AGE_POINTS.find(([within]) => age <= within)?.[1] ?? OLD_POINTS;

export const frecencyOf = (entry: Pick<IndexEntry, "visits" | "recent">, now: number): number => {
    if (entry.recent.length === 0) {
        return entry.visits * OLD_POINTS;
    }
    const points = entry.recent.reduce((sum, visit) => sum + pointsFor(Math.max(0, now - visit.at)) * (visit.typed === true ? TYPED_FACTOR : 1), 0);
    return Math.round((entry.visits * points * 10) / entry.recent.length) / 10;
};

// Only pages a person could go back to: the web, and nothing mid-navigation (Chromium's error and blank pages).
export const rememberable = (url: string): boolean => url.length <= URL_MAX && /^https?:\/\/[^/]/i.test(url);

// The search a results page of one of the address bar's engines stands for, or undefined for any other page.
export const searchTermOf = (url: string): string | undefined => {
    if (!URL.canParse(url)) {
        return undefined;
    }
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./, "");
    const engine = Object.values(SEARCH_ENGINE_INFO).find((info) => info.host.replace(/^www\./, "") === host);
    const term = engine === undefined ? undefined : parsed.searchParams.get(engine.param)?.trim();
    return term === undefined || term === "" ? undefined : term.slice(0, 200);
};

export interface SeedPage {
    readonly url: string;
    readonly title: string | undefined;
    readonly visits: number;
    readonly typed: number;
    readonly last: number;
    readonly recent: readonly RecentVisit[];
}

export interface SeedTerm {
    readonly term: string;
    readonly last: number;
}

export class BrowsingIndex {
    private generation = randomUUID().slice(0, 8);
    private rev = 0;
    // Tombstones only answer cursors at or past this rev; an older one is sent everything.
    private floor = 0;
    private readonly entries = new Map<string, IndexEntry>();
    private readonly terms = new Map<string, IndexTerm>();
    private tombstones: { readonly url: string; readonly rev: number }[] = [];
    seeded = false;

    constructor(file?: IndexFile) {
        if (file === undefined) {
            return;
        }
        this.seeded = file.seeded;
        for (const entry of file.entries) {
            this.entries.set(entry.url, { ...entry, title: entry.title, recent: [...entry.recent], rev: 0 });
        }
        for (const term of file.terms) {
            this.terms.set(term.term.toLowerCase(), { ...term, rev: 0 });
        }
    }

    get size(): number {
        return this.entries.size;
    }

    private bump(): number {
        this.rev += 1;
        return this.rev;
    }

    /** A page committed in a tab of this profile. Answers whether anything changed. */
    visit(url: string, kind: VisitKind, at: number, title?: string): boolean {
        if (!rememberable(url)) {
            return false;
        }
        const known = this.entries.get(url);
        // A reload, or the first leg of a redirect, is not somewhere the person went: only its title may be news.
        if (kind === "reload" || kind === "redirect") {
            return known !== undefined && title !== undefined ? this.retitle(url, title) : false;
        }
        const rev = this.bump();
        const visit: RecentVisit = kind === "typed" ? { at, typed: true } : { at };
        if (known === undefined) {
            this.entries.set(url, {
                url,
                title: title?.slice(0, TITLE_MAX),
                visits: 1,
                typed: kind === "typed" ? 1 : 0,
                last: at,
                recent: [visit],
                rev,
            });
            this.tombstones = this.tombstones.filter((stone) => stone.url !== url);
            this.cap();
        } else {
            known.visits += 1;
            known.typed += kind === "typed" ? 1 : 0;
            known.last = Math.max(known.last, at);
            known.recent = [visit, ...known.recent].slice(0, RECENT_KEPT);
            known.title = title?.slice(0, TITLE_MAX) ?? known.title;
            known.rev = rev;
        }
        const term = searchTermOf(url);
        if (term !== undefined) {
            this.searched(term, at);
        }
        return true;
    }

    /** A page's title arrived after its address did (most do). Answers whether it changed. */
    retitle(url: string, title: string): boolean {
        const known = this.entries.get(url);
        const next = title.slice(0, TITLE_MAX);
        if (known === undefined || next === "" || known.title === next) {
            return false;
        }
        known.title = next;
        known.rev = this.bump();
        return true;
    }

    private searched(term: string, at: number): void {
        const key = term.toLowerCase();
        const known = this.terms.get(key);
        if (known === undefined) {
            this.terms.set(key, { term, count: 1, last: at, rev: this.rev });
        } else {
            known.count += 1;
            known.last = Math.max(known.last, at);
            known.rev = this.rev;
        }
        if (this.terms.size > MAX_TERMS) {
            const oldest = [...this.terms.entries()].toSorted(([, left], [, right]) => left.last - right.last)[0];
            if (oldest !== undefined) {
                this.terms.delete(oldest[0]);
            }
        }
    }

    // Past the ceiling, the pages least worth suggesting go, each leaving a tombstone like any forgotten page.
    private cap(): void {
        if (this.entries.size <= MAX_ENTRIES) {
            return;
        }
        const now = Date.now();
        const worst = [...this.entries.values()]
            .toSorted((left, right) => frecencyOf(left, now) - frecencyOf(right, now) || left.last - right.last)
            .slice(0, this.entries.size - MAX_ENTRIES);
        this.drop(worst.map((entry) => entry.url));
    }

    private drop(urls: readonly string[]): number {
        let removed = 0;
        for (const url of urls) {
            if (this.entries.delete(url)) {
                removed += 1;
                this.tombstones.push({ url, rev: this.bump() });
            }
        }
        if (this.tombstones.length > MAX_TOMBSTONES) {
            const cut = this.tombstones.length - MAX_TOMBSTONES;
            this.floor = this.tombstones[cut - 1]?.rev ?? this.floor;
            this.tombstones = this.tombstones.slice(cut);
        }
        return removed;
    }

    // Everything older than now is answered whole from here on: a new generation no earlier cursor names.
    private restart(): void {
        this.generation = randomUUID().slice(0, 8);
        this.tombstones = [];
        this.floor = this.bump();
    }

    /** Forgets some addresses, a stretch of time, or everything. Answers how many addresses left entirely. */
    forget(what: BrowsingForget): number {
        if (what.kind === "urls") {
            return this.drop(what.urls);
        }
        if (what.kind === "all") {
            const removed = this.entries.size;
            this.entries.clear();
            this.terms.clear();
            this.restart();
            return removed;
        }
        const within = (at: number): boolean => at >= what.from && at < what.to;
        let removed = 0;
        for (const [url, entry] of this.entries) {
            const inside = entry.recent.filter((visit) => within(visit.at));
            if (inside.length === 0 && !within(entry.last)) {
                continue;
            }
            const kept = entry.recent.filter((visit) => !within(visit.at));
            // Only the newest visits are held one by one, so a page whose every held visit is in the stretch goes whole:
            // the older ones are what "forget this stretch" cannot tell apart, and keeping it would keep it suggested.
            if (kept.length === 0) {
                this.entries.delete(url);
                removed += 1;
                continue;
            }
            entry.recent = kept;
            entry.visits = Math.max(kept.length, entry.visits - inside.length);
            entry.typed = Math.max(
                kept.filter((visit) => visit.typed === true).length,
                entry.typed - inside.filter((visit) => visit.typed === true).length,
            );
            entry.last = kept[0]?.at ?? entry.last;
        }
        for (const [key, term] of this.terms) {
            if (within(term.last)) {
                this.terms.delete(key);
            }
        }
        this.restart();
        return removed;
    }

    /** Chromium's own record of the profile, taken in once: pages and searches it knows that this index does not. */
    seed(pages: readonly SeedPage[], terms: readonly SeedTerm[]): void {
        const rev = this.bump();
        for (const page of pages) {
            if (!rememberable(page.url) || this.entries.has(page.url)) {
                continue;
            }
            this.entries.set(page.url, {
                url: page.url,
                title: page.title?.slice(0, TITLE_MAX),
                visits: Math.max(page.visits, page.recent.length),
                typed: page.typed,
                last: page.last,
                recent: page.recent.slice(0, RECENT_KEPT),
                rev,
            });
        }
        for (const term of terms) {
            const key = term.term.toLowerCase();
            if (!this.terms.has(key)) {
                this.terms.set(key, { term: term.term, count: 1, last: term.last, rev });
            }
        }
        this.seeded = true;
        this.cap();
    }

    private cursor(): string {
        return `${this.generation}.${this.rev}`;
    }

    // The rev a cursor of this generation stands at, or undefined for one that must be answered whole.
    private revOf(cursor: string | undefined): number | undefined {
        if (cursor === undefined) {
            return undefined;
        }
        const [generation, rev] = cursor.split(".");
        const at = Number(rev);
        return generation === this.generation && Number.isInteger(at) && at >= this.floor && at <= this.rev ? at : undefined;
    }

    /** The whole index (best first, at most `limit`), or only what changed after `since` when that cursor is current. */
    read(since: string | undefined, now: number, limit = SNAPSHOT_LIMIT): Omit<BrowsingHistory, "profile" | "profiles"> {
        const from = this.revOf(since);
        const entryOf = (entry: IndexEntry): BrowsingEntry => ({
            url: entry.url,
            ...opt("title", entry.title),
            visits: entry.visits,
            typed: entry.typed,
            last: entry.last,
            frecency: frecencyOf(entry, now),
        });
        const termOf = (term: IndexTerm): BrowsingTerm => ({ term: term.term, count: term.count, last: term.last });
        const newest = (left: { last: number }, right: { last: number }): number => right.last - left.last;
        if (from === undefined) {
            const entries = [...this.entries.values()]
                .map(entryOf)
                .toSorted((left, right) => right.frecency - left.frecency || right.last - left.last)
                .slice(0, limit);
            return { cursor: this.cursor(), full: true, entries, removed: [], terms: [...this.terms.values()].toSorted(newest).map(termOf) };
        }
        return {
            cursor: this.cursor(),
            full: false,
            entries: [...this.entries.values()].filter((entry) => entry.rev > from).map(entryOf),
            removed: this.tombstones.filter((stone) => stone.rev > from).map((stone) => stone.url),
            terms: [...this.terms.values()].filter((term) => term.rev > from).toSorted(newest).map(termOf),
        };
    }

    toFile(): IndexFile {
        return {
            seeded: this.seeded,
            entries: [...this.entries.values()].map(({ rev: _rev, title, recent, ...entry }) => ({ ...entry, recent: [...recent], ...opt("title", title) })),
            terms: [...this.terms.values()].map(({ rev: _rev, ...term }) => term),
        };
    }
}

import type { BrowsingEntry, BrowsingTerm, SearchEngine } from "@intentic/sandbox-contract/schemas/browsing";
import { addressOf } from "../address";
import type { PageMarks } from "../bookmarks/bookmarkTree";
import { engineName, type Keyword, parseKeyword, searchUrl } from "./engines";

// What the address bar offers for the text typed so far, ranked here on every keystroke from what the editor already
// holds (the profile's history, the open tabs, the engine's last suggestions), so it answers at the speed of typing
// rather than of a round trip. Measured in rank.test.ts: 5,000 pages ranked well inside a frame.
//
// The first row is what Enter does: the page the text completes to inline ("192" to "192.168.0.168", the rest selected),
// a keyword search, the address typed, or a search. Below it: pages from history, open tabs to switch to, the search
// itself when it is not first, past searches, and the engine's suggestions. A bookmarked page is found whether or not it
// was ever visited, and ranks above plain history at an equal match (`markHistory`).

// One history page, with what matching reads precomputed once per snapshot rather than per keystroke.
export interface PreparedEntry {
    readonly entry: BrowsingEntry;
    // The address lower-cased without its scheme (`www.google.com/maps`), and again without a leading `www.`.
    readonly full: string;
    readonly bare: string;
    // `bare` up to its path: the host and port.
    readonly host: string;
    readonly title: string;
    // What the page is worth before any text matches it: frecency, on a log scale so a page visited daily does not drown
    // out a better match visited weekly, and a bookmark's standing on top.
    readonly worth: number;
    readonly bookmarked: boolean;
    // The site's icon, where a bookmark or an open tab carries one.
    readonly favicon: string | undefined;
}

// What being bookmarked is worth: more than any history earns on visits alone (a frecency of 50,000 is worth about 1,970),
// so at an equal match a bookmark comes first however often the other page was visited, and a bookmark never visited
// still beats a well-visited page matched one tier better.
const BOOKMARK_WORTH = 2000;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

const withoutScheme = (url: string): string => url.replace(SCHEME, ``);

export const prepareHistory = (entries: readonly BrowsingEntry[]): PreparedEntry[] =>
    entries.map((entry) => {
        const full = withoutScheme(entry.url).toLowerCase();
        const bare = full.startsWith(`www.`) ? full.slice(4) : full;
        const slash = bare.indexOf(`/`);
        return {
            entry,
            full,
            bare,
            host: slash === -1 ? bare : bare.slice(0, slash),
            title: (entry.title ?? ``).toLowerCase(),
            worth: 120 * Math.log2(1 + entry.frecency) + (entry.typed > 0 ? 100 : 0),
            bookmarked: false,
            favicon: undefined,
        };
    });

const unvisited = (url: string, title: string): BrowsingEntry => ({ url, title, visits: 0, typed: 0, last: 0, frecency: 0 });

/**
 * The prepared history with the bookmarks and icons the editor holds: each bookmarked page marked and raised, bookmarks
 * never visited added as pages of their own, and every page given its site's icon where one is known. Once per change of
 * either, never per keystroke.
 */
export const markHistory = (prepared: readonly PreparedEntry[], marks: PageMarks): PreparedEntry[] => {
    const seen = new Set<string>();
    const marked = (page: PreparedEntry): PreparedEntry => {
        const bookmark = marks.bookmarks.get(page.entry.url);
        seen.add(page.entry.url);
        const favicon = bookmark?.favicon ?? marks.icons.get(page.host);
        if (bookmark === undefined) {
            return favicon === undefined ? page : { ...page, favicon };
        }
        const entry = page.entry.title === undefined ? { ...page.entry, title: bookmark.title } : page.entry;
        return { ...page, entry, title: (entry.title ?? ``).toLowerCase(), worth: page.worth + BOOKMARK_WORTH, bookmarked: true, favicon };
    };
    const pages = prepared.map(marked);
    const kept = [...marks.bookmarks].filter(([url]) => !seen.has(url));
    return [...pages, ...prepareHistory(kept.map(([url, bookmark]) => unvisited(url, bookmark.title))).map(marked)];
};

// A run of a row's text, marked where the typed text matched it, for the dropdown to draw in bold.
export interface Segment {
    readonly text: string;
    readonly match: boolean;
}

export interface TabCandidate {
    readonly session: string;
    readonly pageId: string;
    readonly url: string;
    readonly title: string | undefined;
    readonly favicon?: string | undefined;
}

interface RowBase {
    // Stable across keystrokes, for the dropdown's keys and the active option's id.
    readonly id: string;
    // What the field shows while this row is picked with the arrows.
    readonly fill: string;
}

export type OmniboxRow =
    | (RowBase & {
          readonly kind: `history`;
          readonly url: string;
          readonly title: Segment[];
          readonly address: Segment[];
          readonly bookmarked: boolean;
          readonly favicon: string | undefined;
      })
    | (RowBase & { readonly kind: `address`; readonly url: string; readonly address: Segment[] })
    | (RowBase & { readonly kind: `search`; readonly url: string; readonly query: string; readonly engine: string })
    | (RowBase & { readonly kind: `keyword`; readonly url: string; readonly query: string; readonly site: Keyword })
    | (RowBase & { readonly kind: `suggestion`; readonly url: string; readonly query: string; readonly past: boolean; readonly text: Segment[] })
    | (RowBase & { readonly kind: `tab`; readonly tab: TabCandidate; readonly title: Segment[]; readonly address: Segment[] });

// Where Enter goes from the default row while the field shows the inline completion.
export interface InlineCompletion {
    // The whole field: what was typed, and the rest of the address after it.
    readonly text: string;
    readonly url: string;
}

export interface OmniboxQuery {
    readonly text: string;
    readonly history: readonly PreparedEntry[];
    readonly tabs: readonly TabCandidate[];
    readonly terms: readonly BrowsingTerm[];
    // The engine's suggestions for this text (or the last text, while this one's are on their way).
    readonly remote: readonly string[];
    readonly engine: SearchEngine;
    // False right after a deletion: completing what was just deleted would put it straight back.
    readonly complete: boolean;
}

export interface OmniboxResult {
    readonly rows: OmniboxRow[];
    readonly inline: InlineCompletion | undefined;
}

const MAX_HISTORY = 5;
const MAX_TABS = 2;
const MAX_PAST = 2;
const MAX_REMOTE = 4;
const MAX_EMPTY = 6;

// How well one typed word matches a page, or 0 for not at all. A match at the start of the address beats one at the
// start of a part of it, which beats one at the start of a word of the title, which beats one anywhere.
const BOUNDARY = new Set([`/`, `.`, `-`, `_`, `?`, `=`, `&`, `#`, `:`, ` `, `+`, `(`, `)`, `,`, `|`, `'`, `"`]);
const atBoundary = (text: string, at: number): boolean => at === 0 || BOUNDARY.has(text.charAt(at - 1));
const boundaryMatch = (text: string, token: string): boolean => {
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
        if (atBoundary(text, at)) {
            return true;
        }
    }
    return false;
};

const tokenScore = (page: PreparedEntry, token: string): number => {
    if (page.bare.startsWith(token) || page.full.startsWith(token)) {
        return 1000;
    }
    const inUrl = page.bare.indexOf(token);
    if (inUrl !== -1 && inUrl < page.host.length && atBoundary(page.bare, inUrl)) {
        return 600;
    }
    if (inUrl !== -1 && boundaryMatch(page.bare, token)) {
        return 400;
    }
    if (page.title !== `` && boundaryMatch(page.title, token)) {
        return 350;
    }
    // Anywhere at all only for a word long enough to mean something there.
    return token.length >= 3 && (inUrl !== -1 || page.title.includes(token)) ? 100 : 0;
};

const pageScore = (page: PreparedEntry, tokens: readonly string[], whole: string): number => {
    let score = 0;
    for (const token of tokens) {
        const one = tokenScore(page, token);
        if (one === 0) {
            return 0;
        }
        score += one;
    }
    // The whole text at the start of the address, spaces and all: the page being typed.
    if (tokens.length > 1 && page.bare.startsWith(whole)) {
        score += 500;
    }
    return score + page.worth;
};

// The text split into runs, those that any typed word matched marked.
export const segmentsOf = (text: string, tokens: readonly string[]): Segment[] => {
    const lower = text.toLowerCase();
    const marked = Array.from({ length: text.length }, () => false);
    for (const token of tokens) {
        if (token === ``) {
            continue;
        }
        const at = lower.indexOf(token);
        if (at !== -1) {
            marked.fill(true, at, at + token.length);
        }
    }
    const segments: Segment[] = [];
    for (let start = 0; start < text.length; ) {
        let end = start;
        while (end < text.length && marked[end] === marked[start]) {
            end += 1;
        }
        segments.push({ text: text.slice(start, end), match: marked[start] === true });
        start = end;
    }
    return segments;
};

// How an address is shown in a row: without its scheme or a bare root's slash, decoded where that is safe to read.
export const shownAddress = (url: string): string => {
    const bare = withoutScheme(url);
    const trimmed = bare.endsWith(`/`) && bare.indexOf(`/`) === bare.length - 1 ? bare.slice(0, -1) : bare;
    try {
        return decodeURI(trimmed);
    } catch {
        // allow(silent-catch): an address with a stray `%` is shown as it was written.
        return trimmed;
    }
};

const trimSlash = (text: string): string => (text.endsWith(`/`) ? text.slice(0, -1) : text);

// Every page whose address starts with the typed text, grouped by site: what an inline completion chooses among.
interface SiteGroup {
    worth: number;
    pages: number;
    // The site's own root page, when it was visited.
    root: PreparedEntry | undefined;
    best: PreparedEntry;
}

const formOf = (page: PreparedEntry, withWww: boolean): string => (withWww ? page.full : page.bare);

const sitesStartingWith = (text: string, history: readonly PreparedEntry[], withWww: boolean): Map<string, SiteGroup> => {
    const sites = new Map<string, SiteGroup>();
    for (const page of history) {
        const form = formOf(page, withWww);
        if (!form.startsWith(text)) {
            continue;
        }
        const host = withWww ? `www.${page.host}` : page.host;
        const group = sites.get(host) ?? { worth: 0, pages: 0, root: undefined, best: page };
        group.worth += page.worth;
        group.pages += 1;
        group.best = page.worth > group.best.worth ? page : group.best;
        group.root = trimSlash(form) === host ? page : group.root;
        sites.set(host, group);
    }
    return sites;
};

// A site's own root, by the scheme and host its best page was reached on.
const rootOf = (page: PreparedEntry): string => {
    const url = new URL(page.entry.url);
    return `${url.protocol}//${url.host}/`;
};

// What a site completes to: the site itself once it was visited more than once or at its root, else its one page.
const siteCompletion = (host: string, group: SiteGroup, withWww: boolean): { readonly completion: string; readonly url: string } =>
    group.root !== undefined || group.pages > 1
        ? { completion: host, url: group.root?.entry.url ?? rootOf(group.best) }
        : { completion: trimSlash(formOf(group.best, withWww)), url: group.best.entry.url };

/**
 * The page the typed text completes to, inline: of every page whose address starts with it, the site most worth going
 * to while the text is still inside a host (completed to the host itself, as a browser does when it has been there
 * more than once or to its root), and the single best page once a path is being typed.
 */
export const inlineCompletion = (typed: string, history: readonly PreparedEntry[]): InlineCompletion | undefined => {
    const text = typed.toLowerCase();
    if (text === `` || /\s/.test(text) || SCHEME.test(text)) {
        return undefined;
    }
    const withWww = text.startsWith(`www.`);
    let chosen: { readonly completion: string; readonly url: string } | undefined;
    if (text.includes(`/`)) {
        const best = history
            .filter((page) => formOf(page, withWww).startsWith(text))
            .reduce<PreparedEntry | undefined>((left, right) => (left === undefined || right.worth > left.worth ? right : left), undefined);
        chosen = best === undefined ? undefined : { completion: trimSlash(formOf(best, withWww)), url: best.entry.url };
    } else {
        const site = [...sitesStartingWith(text, history, withWww).entries()].reduce<[string, SiteGroup] | undefined>(
            (left, right) => (left === undefined || right[1].worth > left[1].worth ? right : left),
            undefined,
        );
        chosen = site === undefined ? undefined : siteCompletion(site[0], site[1], withWww);
    }
    if (chosen === undefined || chosen.completion.length <= text.length) {
        return undefined;
    }
    // The typed part as typed, the rest as the address spells it.
    return { text: `${typed}${chosen.completion.slice(typed.length)}`, url: chosen.url };
};

const historyRow = (page: PreparedEntry, tokens: readonly string[], fill?: string): OmniboxRow => {
    const address = shownAddress(page.entry.url);
    return {
        kind: `history`,
        id: `h:${page.entry.url}`,
        url: page.entry.url,
        fill: fill ?? address,
        title: segmentsOf(page.entry.title ?? address, tokens),
        address: segmentsOf(address, tokens),
        bookmarked: page.bookmarked,
        favicon: page.favicon,
    };
};

const searchRow = (query: string, engine: SearchEngine): OmniboxRow => ({
    kind: `search`,
    id: `s:${query}`,
    url: searchUrl(engine, query),
    fill: query,
    query,
    engine: engineName(engine),
});

// The rows for a field with nothing typed: the pages most worth going back to.
const emptyRows = (history: readonly PreparedEntry[]): OmniboxResult => ({
    rows: history
        .toSorted((left, right) => right.entry.frecency - left.entry.frecency)
        .slice(0, MAX_EMPTY)
        .map((page) => historyRow(page, [])),
    inline: undefined,
});

// The row Enter takes: completed inline, a keyword's search, the address typed, or a search.
const defaultRow = (query: OmniboxQuery, text: string, inline: InlineCompletion | undefined, tokens: readonly string[]): OmniboxRow => {
    const keyword = parseKeyword(text);
    if (inline !== undefined) {
        const page = query.history.find((candidate) => candidate.entry.url === inline.url);
        const address = shownAddress(inline.url);
        return page === undefined
            ? { kind: `address`, id: `a:${inline.url}`, url: inline.url, fill: inline.text, address: segmentsOf(address, tokens) }
            : historyRow(page, tokens, inline.text);
    }
    if (keyword !== undefined) {
        return { kind: `keyword`, id: `k:${keyword.site.keyword}`, url: keyword.url, fill: text, query: keyword.query, site: keyword.site };
    }
    const address = addressOf(text);
    if (address === undefined) {
        return searchRow(text, query.engine);
    }
    // An address typed whole that history knows is that page's row, under its own title, not a second row beside it.
    const known = query.history.find((page) => trimSlash(page.entry.url) === trimSlash(address));
    return known === undefined
        ? { kind: `address`, id: `a:${address}`, url: address, fill: text, address: segmentsOf(shownAddress(address), tokens) }
        : historyRow(known, tokens, text);
};

const matchedTabs = (tabs: readonly TabCandidate[], tokens: readonly string[]): TabCandidate[] =>
    tabs
        .filter((tab) => {
            const haystack = `${withoutScheme(tab.url)} ${tab.title ?? ``}`.toLowerCase();
            return tokens.every((token) => haystack.includes(token));
        })
        .slice(0, MAX_TABS);

export const rankOmnibox = (query: OmniboxQuery): OmniboxResult => {
    const text = query.text.trim();
    if (text === ``) {
        return emptyRows(query.history);
    }
    const lower = text.toLowerCase();
    const tokens = lower.split(/\s+/u);
    const inline = query.complete && query.text === text ? inlineCompletion(text, query.history) : undefined;
    const first = defaultRow(query, text, inline, tokens);
    const searching = first.kind === `search` || first.kind === `keyword`;

    // Best few pages, kept in a short sorted list rather than sorting every page that matched.
    const top: { page: PreparedEntry; score: number }[] = [];
    for (const page of query.history) {
        const score = pageScore(page, tokens, lower);
        if (score === 0 || (top.length === MAX_HISTORY + 1 && score <= (top.at(-1)?.score ?? 0))) {
            continue;
        }
        top.push({ page, score });
        top.sort((left, right) => right.score - left.score);
        top.length = Math.min(top.length, MAX_HISTORY + 1);
    }
    const tabs = matchedTabs(query.tabs, tokens);
    const openUrls = new Set(tabs.map((tab) => tab.url));
    const taken = new Set([`url` in first ? first.url : ``]);
    const pages = top
        .filter(({ page }) => !taken.has(page.entry.url) && !openUrls.has(page.entry.url))
        // A search's history is only what matched it well; an address's is anything that matched.
        .filter(({ score, page }) => !searching || score - page.worth >= 350 * tokens.length)
        .slice(0, searching ? 3 : MAX_HISTORY)
        .map(({ page }) => historyRow(page, tokens));
    const tabRows = tabs.map(
        (tab): OmniboxRow => ({
            kind: `tab`,
            id: `t:${tab.session}:${tab.pageId}`,
            fill: shownAddress(tab.url),
            tab,
            title: segmentsOf(tab.title ?? shownAddress(tab.url), tokens),
            address: segmentsOf(shownAddress(tab.url), tokens),
        }),
    );
    const said = new Set([lower]);
    const past = query.terms
        .filter((term) => term.term.toLowerCase().startsWith(lower) && !said.has(term.term.toLowerCase()))
        .slice(0, MAX_PAST);
    for (const term of past) {
        said.add(term.term.toLowerCase());
    }
    const remote = query.remote.filter((suggestion) => !said.has(suggestion.toLowerCase())).slice(0, MAX_REMOTE);
    const suggestion = (value: string, isPast: boolean): OmniboxRow => ({
        kind: `suggestion`,
        id: `q:${value}`,
        url: searchUrl(query.engine, value),
        fill: value,
        query: value,
        past: isPast,
        text: segmentsOf(value, [lower]),
    });
    return {
        rows: [
            first,
            ...pages,
            ...tabRows,
            ...(first.kind === `search` ? [] : [searchRow(text, query.engine)]),
            ...past.map((term) => suggestion(term.term, true)),
            ...remote.map((value) => suggestion(value, false)),
        ],
        inline,
    };
};

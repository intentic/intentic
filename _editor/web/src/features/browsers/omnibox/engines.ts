import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINE_INFO, type SearchEngine, SearchEngineSchema } from "@intentic/sandbox-contract/schemas/browsing";

// Where the address bar sends a search: the engine the sandbox's settings name (`searchEngine`), and a few keywords that
// send one straight to a site's own search instead (`yt lofi` searches YouTube), the way a browser's search shortcuts do.

/** The address of a search for `query` on `engine`. */
export const searchUrl = (engine: SearchEngine, query: string): string => `${SEARCH_ENGINE_INFO[engine].search}${encodeURIComponent(query)}`;

export const engineName = (engine: SearchEngine): string => SEARCH_ENGINE_INFO[engine].name;

// The engine a stored setting names, or the default for one this build does not know (a setting from a newer sandbox).
export const engineOf = (value: string | undefined): SearchEngine => SearchEngineSchema.safeParse(value).data ?? DEFAULT_SEARCH_ENGINE;

export interface Keyword {
    // What is typed before the space.
    readonly keyword: string;
    // The site, as a row names it.
    readonly name: string;
    // The query, URL-encoded, goes on the end.
    readonly search: string;
}

// A small set a person can guess: the sites developers search most, and each engine by a short name.
const KEYWORDS: readonly Keyword[] = [
    { keyword: `yt`, name: `YouTube`, search: `https://www.youtube.com/results?search_query=` },
    { keyword: `gh`, name: `GitHub`, search: `https://github.com/search?q=` },
    { keyword: `w`, name: `Wikipedia`, search: `https://en.wikipedia.org/wiki/Special:Search?search=` },
    { keyword: `npm`, name: `npm`, search: `https://www.npmjs.com/search?q=` },
    { keyword: `mdn`, name: `MDN`, search: `https://developer.mozilla.org/en-US/search?q=` },
    { keyword: `g`, name: SEARCH_ENGINE_INFO.google.name, search: SEARCH_ENGINE_INFO.google.search },
    { keyword: `ddg`, name: SEARCH_ENGINE_INFO.duckduckgo.name, search: SEARCH_ENGINE_INFO.duckduckgo.search },
    { keyword: `bing`, name: SEARCH_ENGINE_INFO.bing.name, search: SEARCH_ENGINE_INFO.bing.search },
    { keyword: `k`, name: SEARCH_ENGINE_INFO.kagi.name, search: SEARCH_ENGINE_INFO.kagi.search },
    { keyword: `brave`, name: SEARCH_ENGINE_INFO.brave.name, search: SEARCH_ENGINE_INFO.brave.search },
];

const BY_KEYWORD = new Map(KEYWORDS.map((entry) => [entry.keyword, entry]));

export interface KeywordSearch {
    readonly site: Keyword;
    readonly query: string;
    readonly url: string;
}

/**
 * A keyword search, when the text is a keyword, a space and something to search for: `yt lofi beats`, `gh vue router`.
 * The keyword alone, or followed only by spaces, is not one yet: it may still be the start of an address.
 */
export const parseKeyword = (text: string): KeywordSearch | undefined => {
    const match = /^(\S+)\s+(\S.*)$/u.exec(text.trimStart());
    const site = match?.[1] === undefined ? undefined : BY_KEYWORD.get(match[1].toLowerCase());
    const query = match?.[2]?.trim();
    if (site === undefined || query === undefined || query === ``) {
        return undefined;
    }
    return { site, query, url: `${site.search}${encodeURIComponent(query)}` };
};

import type { SearchEngine, SearchSuggestions } from "@intentic/sandbox-contract/schemas/browsing";
import { z } from "zod";

// What a search engine suggests for the text in the address bar, fetched from the sandbox so the engine sees the address
// the browsing itself leaves from, not the person's own. The address bar ranks its own suggestions without waiting for
// these, so a slow engine is cut off quickly and answered as nothing, and a repeat of the same text (typing, then
// deleting back to it) is answered from a small cache.

// Each engine's suggestion endpoint, as Firefox's own engine definitions ask them. All answer OpenSearch's
// `[query, [suggestion, …]]`; DuckDuckGo answers a list of `{ phrase }` without `type=list`, which is parsed too in case
// it ever drops the parameter. Bing answers 204 with nothing to a request that does not look like a browser's, so
// every request carries a browser's user agent.
const ENDPOINTS = {
    brave: (query: string) => `https://search.brave.com/api/suggest?q=${encodeURIComponent(query)}`,
    google: (query: string) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`,
    duckduckgo: (query: string) => `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=list`,
    bing: (query: string) => `https://www.bing.com/osjson.aspx?query=${encodeURIComponent(query)}&form=OSDJAS`,
    kagi: (query: string) => `https://kagi.com/api/autosuggest?q=${encodeURIComponent(query)}`,
} as const satisfies Readonly<Record<SearchEngine, (query: string) => string>>;

// A desktop Chromium on Linux, which is what the sandbox's browser is; the version only needs to be a plausible one.
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const OpenSearchSchema = z.tuple([z.string(), z.array(z.unknown())]).rest(z.unknown());
const PhraseListSchema = z.array(z.object({ phrase: z.string() }));

// The suggestions out of an engine's answer, whichever of the two shapes it is; none for anything else.
export const parseSuggestions = (text: string): string[] => {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        // allow(silent-catch): an answer that is not JSON (a captcha page, an error page) suggests nothing.
        return [];
    }
    const open = OpenSearchSchema.safeParse(body);
    if (open.success) {
        return open.data[1].filter((entry): entry is string => typeof entry === "string");
    }
    const phrases = PhraseListSchema.safeParse(body);
    return phrases.success ? phrases.data.map((entry) => entry.phrase) : [];
};

// Past this the address bar has moved on: what it shows from history is already there.
const TIMEOUT_MS = 1500;
const CACHE_MS = 10 * 60_000;
const CACHE_SIZE = 300;
const MAX_SUGGESTIONS = 8;

export interface SuggestDeps {
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
    // The languages the sandbox's own browser asks pages in, so its suggestions come in the same ones.
    readonly acceptLanguage?: () => Promise<string | undefined>;
    readonly now?: () => number;
    readonly timeoutMs?: number;
}

export type Suggest = (query: string, engine: SearchEngine) => Promise<SearchSuggestions>;

export const searchSuggester = (deps: SuggestDeps): Suggest => {
    const now = deps.now ?? Date.now;
    const cache = new Map<string, { readonly at: number; readonly suggestions: readonly string[] }>();
    const inFlight = new Map<string, Promise<readonly string[]>>();

    const ask = async (query: string, engine: SearchEngine): Promise<readonly string[]> => {
        try {
            const headers = new Headers({ accept: "application/json, application/x-suggestions+json", "user-agent": USER_AGENT });
            const language = await deps.acceptLanguage?.();
            if (language !== undefined) {
                headers.set("accept-language", language);
            }
            const response = await deps.fetch(ENDPOINTS[engine](query), {
                headers,
                signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
            });
            if (!response.ok) {
                return [];
            }
            return parseSuggestions(await response.text())
                .map((entry) => entry.trim())
                .filter((entry) => entry !== "")
                .slice(0, MAX_SUGGESTIONS);
        } catch {
            // allow(silent-catch): an engine slow, unreachable or answering something else has simply nothing to add;
            // the address bar's own suggestions stand.
            return [];
        }
    };

    return async (query, engine) => {
        const text = query.trim();
        const key = `${engine}\n${text.toLowerCase()}`;
        const cached = cache.get(key);
        if (cached !== undefined && now() - cached.at < CACHE_MS) {
            return { q: query, suggestions: [...cached.suggestions] };
        }
        const asking = inFlight.get(key) ?? ask(text, engine);
        inFlight.set(key, asking);
        const suggestions = await asking.finally(() => inFlight.delete(key));
        // An empty answer is not kept: it is as likely the engine's hiccup as its verdict.
        if (suggestions.length > 0) {
            cache.delete(key);
            cache.set(key, { at: now(), suggestions });
            if (cache.size > CACHE_SIZE) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) {
                    cache.delete(oldest);
                }
            }
        }
        return { q: query, suggestions: [...suggestions] };
    };
};

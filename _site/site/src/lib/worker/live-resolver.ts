import { type LiveContent, LIVE_CACHE_SECONDS, LIVE_CONTENT_URL, parseLiveContent } from "../live";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createLiveContentResolver(fetchImpl: Fetch, now: () => number = Date.now) {
    let cache: { content: LiveContent | undefined; at: number } | undefined;
    let pending: Promise<LiveContent | undefined> | undefined;

    async function read(): Promise<LiveContent | undefined> {
        let content: LiveContent | undefined;
        try {
            const response = await fetchImpl(LIVE_CONTENT_URL, { cf: { cacheTtl: LIVE_CACHE_SECONDS, cacheEverything: true } });
            if (response.ok) {
                content = parseLiveContent(await response.json());
            } else {
                console.warn(`live content: ${LIVE_CONTENT_URL} answered ${response.status}; the built page stands and no switch applies`);
            }
        } catch (error) {
            console.warn(`live content: ${LIVE_CONTENT_URL} could not be read (${String(error)}); the built page stands and no switch applies`);
        }
        cache = { content, at: now() };
        return content;
    }

    return async (): Promise<LiveContent | undefined> => {
        if (cache !== undefined && now() - cache.at < LIVE_CACHE_SECONDS * 1000) {
            return cache.content;
        }
        // Share the read through body parsing; concurrent requests must use the same notice and switches.
        pending ??= read().finally(() => {
            pending = undefined;
        });
        return pending;
    };
}

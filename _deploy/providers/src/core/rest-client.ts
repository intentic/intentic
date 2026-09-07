/* THE THREE THINGS EVERY FORGE ADAPTER IN HERE DOES THE SAME WAY. github-api.ts, gitlab-api.ts and
 * forgejo-api.ts are each a thin, stateless wrapper over one vendor's REST surface, and each had written the
 * same request shape out per call: bound the connection, treat a 404 as "not there" rather than as a failure,
 * turn any other non-2xx into an error that names what was asked.
 *
 * Fifteen hand-written copies of that is fifteen chances to differ, and they did — some threw with the
 * response body attached and some threw with only the status, so which of two identical-looking failures you
 * could actually diagnose depended on which endpoint it came from. The vendor's own words are the useful part
 * of a forge error ("secret scanning must be enabled", "you have exceeded a rate limit"), so they are always
 * carried here.
 *
 * `vendor` is only ever a label in an error message. Everything else — base urls, auth headers, which paths
 * exist — stays in the adapter, because that is the part that is genuinely per-forge. */

// undici's default headers timeout is ~5 minutes, which is long enough that a stalled connection reads as a
// hung deploy rather than as a failed request. Every call here is a small JSON round trip to a forge.
const TIMEOUT_MS = 30_000;

export interface RestClient {
    /* A request that must succeed. Answers the parsed JSON body, or `undefined` for a 204 (the forges use it
     * for deletes and for "accepted, nothing to say"). Throws on any non-2xx, 404 included: a caller reaching
     * for this is asking about something it believes exists. */
    readonly json: (url: string, init?: RequestInit) => Promise<unknown>;
    /* A request whose subject may not exist. Answers the Response on 2xx and `undefined` on 404; throws on
     * every other non-2xx, because "the token is not allowed to look" must never be read as "not there" —
     * that mistake makes a provider create a duplicate of something it already owns. The Response rather than
     * its body, so the caller can `.json()` it against its own schema or ignore it entirely (a delete). */
    readonly maybe: (url: string, init?: RequestInit) => Promise<Response | undefined>;
}

export const restClient = (vendor: string): RestClient => {
    const send = async (url: string, init: RequestInit | undefined): Promise<Response> =>
        fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

    const fail = async (url: string, init: RequestInit | undefined, response: Response): Promise<never> => {
        const body = await response.text().catch(() => "");
        throw new Error(`${vendor} API ${init?.method ?? "GET"} ${url}: ${response.status} ${body}`.trimEnd());
    };

    return {
        json: async (url, init) => {
            const response = await send(url, init);
            if (!response.ok) {
                return fail(url, init, response);
            }
            return response.status === 204 ? undefined : response.json();
        },
        maybe: async (url, init) => {
            const response = await send(url, init);
            if (response.status === 404) {
                return undefined;
            }
            if (!response.ok) {
                return fail(url, init, response);
            }
            return response;
        },
    };
};

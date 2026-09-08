// Shared REST wrapper for github-api.ts, gitlab-api.ts and forgejo-api.ts: bounds the connection, treats 404 as
// absent rather than a failure, and turns any other non-2xx into an error carrying the vendor's response body.
// `vendor` is only a label for error messages; base urls, auth headers and paths stay in each adapter.

// Undici's ~5min default timeout would read a stalled connection as a hung deploy, not a failed request.
const TIMEOUT_MS = 30_000;

export interface RestClient {
    // A request that must succeed: returns the parsed body, or undefined for a 204. Throws on any non-2xx, 404
    // included, since a caller here believes the thing exists.
    readonly json: (url: string, init?: RequestInit) => Promise<unknown>;
    // A request whose subject may not exist: returns the Response on 2xx, undefined on 404, and throws on any other
    // non-2xx so a permission error is never read as absent. Returns the Response itself so callers parse or discard
    // it.
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

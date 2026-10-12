import { FetchJsonError, fetchJsonResponse, type FetchJsonInit, type JsonResponse, type JsonValue } from "@intentic/base/fetch-json";
import { responseDetail } from "./response-detail.js";

// How every vendor adapter here calls its JSON API: base's one transport (a 30 s deadline that also covers reading the
// body, a timeout told apart from a host that could not be reached, the call named in the error), with a refusal's
// body put through responseDetail first, so a Cloudflare edge page in front of a self-hosted vendor is named by its
// code and anything else is one bounded line. Statuses the caller accepts keep their body to read (Discord's 429).
export const vendorRequest = (url: string, init: FetchJsonInit): Promise<JsonResponse> => {
    const accept = init.accept ?? [];
    return fetchJsonResponse(url, {
        ...init,
        // SAFETY: bun-types' `fetch` carries `preconnect`, which base's transport never calls; the wrapper is a fetch and no more.
        fetch: (async (input: Parameters<typeof fetch>[0], sent?: Parameters<typeof fetch>[1]): Promise<Response> => {
            const response = await fetch(input, sent);
            return response.ok || accept.includes(response.status) ? response : new Response(await responseDetail(response), { status: response.status });
        }) as typeof fetch,
    });
};

// Shared REST wrapper for github-api.ts and gitlab-api.ts over vendorRequest: 404 treated as absent rather than a
// failure, and any other non-2xx turned into an error carrying the start of the vendor's response body.
// `vendor` is only a label for error messages; base urls, auth headers and paths stay in each adapter.

// What `maybe` answers for a thing that exists: its body, already read, behind the one method callers use.
export interface RestAnswer {
    readonly json: () => Promise<JsonValue | undefined>;
}

export interface RestClient {
    // A request that must succeed: returns the parsed body, or undefined for an empty one (204). Throws on any non-2xx,
    // 404 included, since a caller here believes the thing exists.
    readonly json: (url: string, init?: RequestInit) => Promise<unknown>;
    // Return undefined only for 404; propagate other non-2xx responses.
    readonly maybe: (url: string, init?: RequestInit) => Promise<RestAnswer | undefined>;
}

export const restClient = (vendor: string): RestClient => {
    const send = async (url: string, init: RequestInit | undefined, accept: readonly number[]) => {
        const method = init?.method ?? "GET";
        try {
            const request = { method, headers: init?.headers ?? {}, accept, label: `${vendor} API ${method} ${url}` };
            // A GET takes no body at all, not even an empty one, so it is only sent when the caller gave one.
            const body = init?.body ?? undefined;
            return await vendorRequest(url, body === undefined ? request : { ...request, body });
        } catch (error) {
            // A refusal keeps the message shape callers and logs already know: vendor, method, url, status, body.
            if (error instanceof FetchJsonError && error.kind === "status") {
                throw new Error(`${vendor} API ${method} ${url}: ${error.status} ${error.body ?? ""}`.trimEnd(), { cause: error });
            }
            throw error;
        }
    };

    return {
        json: async (url, init) => (await send(url, init, [])).json,
        maybe: async (url, init) => {
            const response = await send(url, init, [404]);
            if (response.status === 404) {
                return undefined;
            }
            return { json: () => Promise.resolve(response.json) };
        },
    };
};

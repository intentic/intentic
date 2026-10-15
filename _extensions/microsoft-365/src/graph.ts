import { type Account, assertWrite, cloudOf } from "./accounts.js";
import type { Http } from "./auth.js";

// Microsoft Graph for one card: every URL is pinned to the card's own cloud (a nextLink pointing anywhere else is
// refused before the bearer goes out), every write is refused on a read-only card before a token is even minted, and a
// failure is said by its status alone, since Graph's error body can quote the mail or file it refused.

export interface Page<T> {
    value?: T[];
    "@odata.nextLink"?: string;
    "@odata.deltaLink"?: string;
}

export class GraphError extends Error {
    constructor(readonly status: number) {
        super(`Microsoft Graph refused the request (${status}${GraphError.meaning(status)})`);
    }
    private static meaning(status: number): string {
        if (status === 401) {
            return ": the sign-in expired, run `m365 auth login`";
        }
        if (status === 403) {
            return ": this account or its permissions do not reach that";
        }
        if (status === 404) {
            return ": no such item, or it moved";
        }
        return status === 429 ? ": Microsoft is throttling, try again in a minute" : "";
    }
}

// A JSON value as Graph answers it and as `m365` prints it.
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined };

// Graph's own answer headers: `Prefer` picks a mail body's text form or a calendar's time zone.
export type GraphHeaders = Readonly<Record<string, string>>;

export interface Request {
    readonly method?: string;
    // Sent as JSON.
    readonly body?: unknown;
    // Sent as they are, for a file's content.
    readonly bytes?: Uint8Array<ArrayBuffer>;
    readonly headers?: GraphHeaders;
}

export class Graph {
    readonly origin: string;
    constructor(
        readonly account: Account,
        private readonly token: () => Promise<string>,
        private readonly http: Http = fetch,
    ) {
        this.origin = `https://${cloudOf(account).graph}`;
    }

    private url(path: string): string {
        const url = new URL(path.startsWith("https:") ? path : `${this.origin}/v1.0${path}`);
        if (url.origin !== this.origin || url.username || url.password || !url.pathname.startsWith("/v1.0/")) {
            throw new Error("A Graph address outside this card's cloud is refused");
        }
        return url.toString();
    }

    async response(path: string, request: Request = {}): Promise<Response> {
        const method = request.method ?? "GET";
        if (method !== "GET") {
            assertWrite(this.account);
        }
        const init: RequestInit = {
            method,
            // Graph's /content answers a redirect to storage; following it here would carry the bearer there.
            redirect: "manual",
            signal: AbortSignal.timeout(60_000),
            headers: {
                authorization: `Bearer ${await this.token()}`,
                "content-type": request.bytes === undefined ? "application/json" : "application/octet-stream",
                ...request.headers,
            },
        };
        if (request.bytes !== undefined) {
            init.body = request.bytes;
        } else if (request.body !== undefined) {
            init.body = JSON.stringify(request.body);
        }
        const response = await this.http(this.url(path), init);
        if (!response.ok) {
            throw new GraphError(response.status);
        }
        return response;
    }

    async call<T>(path: string, request: Request = {}): Promise<T> {
        const response = await this.response(path, request);
        const empty = response.status === 202 || response.status === 204 || response.headers.get("content-length") === "0";
        // SAFETY: Graph answers JSON for every route this CLI calls; the caller names the shape it reads.
        return empty ? (undefined as T) : ((await response.json()) as T);
    }

    // Follows nextLink until `limit` items are in hand: a mailbox or a library can hold far more than anyone asked for,
    // and every page is a request against the tenant's throttling budget.
    async list<T>(path: string, limit: number, headers?: GraphHeaders): Promise<T[]> {
        const values: T[] = [];
        const visited = new Set<string>();
        let next: string | undefined = path;
        while (next !== undefined && values.length < limit) {
            if (visited.has(next)) {
                throw new Error("Graph pagination repeated a page");
            }
            visited.add(next);
            const page: Page<T> = await this.call<Page<T>>(next, { headers: headers ?? {} });
            values.push(...(page.value ?? []));
            next = page["@odata.nextLink"];
        }
        return values.slice(0, limit);
    }
}

// One path segment from an id the agent passed: Graph ids hold `/`, `+` and `=`, and OData quotes need doubling.
export const segment = (value: string): string => encodeURIComponent(value).replaceAll("'", "%27");

export const query = (params: Record<string, string | undefined>): string =>
    new URLSearchParams(Object.entries(params).filter((pair): pair is [string, string] => pair[1] !== undefined)).toString();

import { setTimeout as sleep } from "node:timers/promises";
import type { Session } from "./session.js";

/* EVERY REQUEST TO GOOGLE GOES THROUGH HERE, authorization, retries, paging and, above all, errors that say
 * what to do.
 *
 * Google's failures arrive as `{error: {code, message, status, details}}`, and the useful part is rarely the
 * message: a 403 from Gmail on a fresh project is an API nobody enabled, a 403 on an old one is usually a
 * scope the consent never granted, and both read as "Request had insufficient authentication scopes". The
 * agent relays whatever it is handed to the owner, so what is handed to it has to name the fix.
 *
 * A 401 is handled rather than reported: an access token that expired mid-command is not a condition anybody
 * should hear about, so the session mints a new one and the request is made again, once. */

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

export interface CallSpec {
    readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    readonly url: string;
    readonly query?: Record<string, string | number | boolean | readonly string[] | undefined>;
    readonly body?: unknown;
    /* A pre-encoded payload (a MIME message, a multipart upload, raw file bytes) instead of a JSON body. The
     * buffer is pinned to `ArrayBuffer` rather than the wider `ArrayBufferLike` because that is what `fetch`
     * takes, a Buffer over a SharedArrayBuffer is not a body, and nothing here produces one. */
    readonly raw?: { readonly contentType: string; readonly data: Uint8Array<ArrayBuffer> | string };
}

export class GoogleApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "GoogleApiError";
    }
}

// Rate limits and the transient 5xx family back off; everything else is the answer. Google sends Retry-After
// on some quota refusals and it is authoritative when it does.
export const retryDelay = (attempt: number, retryAfter: string | null): number => {
    const declared = retryAfter === null ? Number.NaN : Number.parseInt(retryAfter, 10);
    if (Number.isFinite(declared) && declared >= 0) {
        return Math.min(declared, 30) * 1000;
    }
    return 500 * 2 ** (attempt - 1);
};

const API_ENABLE_HINT: Record<string, string> = {
    gmail: "Gmail API",
    calendar: "Google Calendar API",
    drive: "Google Drive API",
    docs: "Google Docs API",
    sheets: "Google Sheets API",
    people: "People API",
};

const serviceOf = (url: string): string | undefined => {
    const host = /^https:\/\/([a-z]+)\.googleapis\.com/.exec(url)?.[1];
    return host === undefined ? undefined : Object.keys(API_ENABLE_HINT).find((service) => host.startsWith(service));
};

export const googleError = (status: number, url: string, body: unknown): GoogleApiError => {
    const error = (body as { error?: Record<string, unknown> } | undefined)?.error;
    const message = typeof error?.["message"] === "string" ? error["message"] : `HTTP ${status}`;
    const service = serviceOf(url);
    if (status === 403 && /has not been used|is disabled/i.test(message)) {
        const api = service === undefined ? "the API this needs" : API_ENABLE_HINT[service];
        return new GoogleApiError(`${message.split(".")[0] ?? message}. Enable ${api} for the project in console.cloud.google.com.`, status);
    }
    if (status === 403 && /insufficient|scope/i.test(message)) {
        return new GoogleApiError(
            `Google refused this for lack of permission: ${message} — the connection was approved for narrower scopes than it needs. Re-approve it with the scopes listed on the card, or add the scope to the service account's domain-wide delegation.`,
            status,
        );
    }
    if (status === 404) {
        return new GoogleApiError(`${message} — check the id, and that this account can actually see that item.`, status);
    }
    if (status === 429) {
        return new GoogleApiError(`Google is rate-limiting this account: ${message}. Try again in a minute, or do less at once.`, status);
    }
    return new GoogleApiError(message, status);
};

const withQuery = (url: string, query: CallSpec["query"]): string => {
    if (query === undefined) {
        return url;
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined) {
            continue;
        }
        // Google's list endpoints take repeated keys for set-valued filters (labelIds, fields on some APIs).
        for (const one of Array.isArray(value) ? value : [value]) {
            params.append(key, String(one));
        }
    }
    const encoded = params.toString();
    return encoded === "" ? url : `${url}${url.includes("?") ? "&" : "?"}${encoded}`;
};

const send = async (session: Session, spec: CallSpec): Promise<Response> => {
    const url = withQuery(spec.url, spec.query);
    let token = await session.token();
    let refreshed = false;
    for (let attempt = 1; ; attempt += 1) {
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        if (spec.raw !== undefined) {
            headers["content-type"] = spec.raw.contentType;
        } else if (spec.body !== undefined) {
            headers["content-type"] = "application/json";
        }
        const response = await fetch(url, {
            method: spec.method ?? "GET",
            headers,
            body: spec.raw?.data ?? (spec.body === undefined ? null : JSON.stringify(spec.body)),
        });
        if (response.ok) {
            return response;
        }
        if (response.status === 401 && !refreshed) {
            refreshed = true;
            token = await session.refresh();
            continue;
        }
        if (RETRY_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
            await response.body?.cancel().catch(() => undefined);
            await sleep(retryDelay(attempt, response.headers.get("retry-after")));
            continue;
        }
        throw googleError(response.status, url, await response.json().catch(() => undefined));
    }
};

export const call = async <T>(session: Session, spec: CallSpec): Promise<T> => {
    const response = await send(session, spec);
    // 204 on a delete, and Gmail's modify endpoints answer 204 for some verbs.
    if (response.status === 204) {
        return undefined as T;
    }
    return (await response.json()) as T;
};

export const callBytes = async (session: Session, spec: CallSpec): Promise<Buffer> => Buffer.from(await (await send(session, spec)).arrayBuffer());

/* Every Google list endpoint pages the same way, `pageToken` in, `nextPageToken` out, and every one of them
 * will happily walk a 30,000-message mailbox if nothing stops it. `limit` is that stop, and it is required
 * rather than optional: an unbounded paginate reached from a CLI is a command that never returns.
 *
 * The page-size parameter is NOT the same name across Google's own APIs (`maxResults` on Gmail and Calendar,
 * `pageSize` on Drive, Sheets and People), which is exactly the kind of difference a caller forgets, so it is
 * named per call rather than defaulted silently to whichever one was written first. */
export interface PageSpec<T> {
    readonly itemsOf: (page: Record<string, unknown>) => readonly T[] | undefined;
    readonly limit: number;
    readonly sizeKey: "maxResults" | "pageSize";
    readonly maxPageSize?: number;
}

export const paginate = async <T>(session: Session, spec: CallSpec, page: PageSpec<T>): Promise<T[]> => {
    const collected: T[] = [];
    let pageToken: string | undefined;
    do {
        const body = await call<Record<string, unknown>>(session, {
            ...spec,
            query: { ...spec.query, pageToken, [page.sizeKey]: Math.min(page.limit - collected.length, page.maxPageSize ?? 100) },
        });
        collected.push(...(page.itemsOf(body) ?? []));
        pageToken = typeof body["nextPageToken"] === "string" ? body["nextPageToken"] : undefined;
    } while (pageToken !== undefined && collected.length < page.limit);
    return collected.slice(0, page.limit);
};

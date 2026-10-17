import { setTimeout as sleep } from "node:timers/promises";
import { retryAfterMs } from "@intentic/base/async";
import { fetchJsonResponse, type JsonValue } from "@intentic/base/fetch-json";
import { parseJsonOr } from "@intentic/base/json";
import type { Session } from "./session.js";

// Every request to Google goes through here: authorization, retries, paging, and errors that name the fix. Google's
// `{error:{message,...}}` rarely says enough alone (a 403 could mean an unenabled API or a missing scope), so this
// rewrites it. A 401 is retried once with a fresh token rather than reported. Each attempt has a deadline and takes
// the caller's abort; until 2026-10 none did, so a stalled connection hung the command for undici's ~5 minutes.

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

export interface CallSpec {
    readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    readonly url: string;
    readonly query?: Record<string, string | number | boolean | readonly string[] | undefined>;
    readonly body?: unknown;
    // A pre-encoded payload (MIME, multipart, raw bytes) instead of JSON; `ArrayBuffer` is what `fetch` takes.
    readonly raw?: { readonly contentType: string; readonly data: Uint8Array<ArrayBuffer> | string };
    // Ends the call, a retry's wait included.
    readonly signal?: AbortSignal;
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

// Rate limits and the transient 5xx family back off; everything else is the answer. Google's Retry-After header is
// authoritative when present, up to half a minute.
export const retryDelay = (attempt: number, retryAfter: string | null, now = Date.now()): number =>
    retryAfterMs(retryAfter, { now, capMs: 30_000 }) ?? 500 * 2 ** (attempt - 1);

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

// One entry of a refusal's `details` (an AIP-193 ErrorInfo) or of its legacy `errors`, each with a machine `reason`.
const isReasoned = (entry: JsonValue): entry is { readonly reason: string } =>
    typeof entry === "object" && entry !== null && "reason" in entry && typeof entry["reason"] === "string";

// The reasons Google gives a refusal for code to read: ErrorInfo's (SERVICE_DISABLED, ACCESS_TOKEN_SCOPE_INSUFFICIENT)
// and the v1 APIs' older ones (accessNotConfigured, insufficientPermissions).
const reasonsOf = (error: Record<string, unknown> | undefined): ReadonlySet<string> =>
    new Set([error?.["details"], error?.["errors"]].flatMap((list) => (Array.isArray(list) ? list.filter(isReasoned).map((entry) => entry.reason) : [])));

const DISABLED_REASONS = ["SERVICE_DISABLED", "accessNotConfigured"];
const SCOPE_REASONS = ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions"];

// Google's sentence, read only where a refusal carries no reason at all.
// allow(dependency-text): Google API error.message; an unmatched 403 is relayed as Google phrased it.
const saysDisabled = (message: string): boolean => /has not been used|is disabled/i.test(message);
// allow(dependency-text): Google API error.message; an unmatched 403 is relayed as Google phrased it.
const saysScope = (message: string): boolean => /insufficient authentication scopes/i.test(message);

// `challenge` is the WWW-Authenticate header, whose RFC 6750 error says a token's scope fell short.
export const googleError = (status: number, url: string, body: unknown, challenge?: string | null): GoogleApiError => {
    const error = (body as { error?: Record<string, unknown> } | undefined)?.error;
    const message = typeof error?.["message"] === "string" ? error["message"] : `HTTP ${status}`;
    const service = serviceOf(url);
    const reasons = reasonsOf(error);
    const reasoned = reasons.size > 0;
    if (status === 403 && (DISABLED_REASONS.some((reason) => reasons.has(reason)) || (!reasoned && saysDisabled(message)))) {
        const api = service === undefined ? "the API this needs" : API_ENABLE_HINT[service];
        return new GoogleApiError(`${message.split(".")[0] ?? message}. Enable ${api} for the project in console.cloud.google.com.`, status);
    }
    const scopeShort = /\berror="?insufficient_scope\b/.test(challenge ?? "");
    if (status === 403 && (scopeShort || SCOPE_REASONS.some((reason) => reasons.has(reason)) || (!reasoned && saysScope(message)))) {
        return new GoogleApiError(
            `Google refused this for lack of permission: ${message}, the connection was approved for narrower scopes than it needs. Re-approve it with the scopes listed on the card, or add the scope to the service account's domain-wide delegation.`,
            status,
        );
    }
    if (status === 404) {
        return new GoogleApiError(`${message}: check the id, and that this account can actually see that item.`, status);
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

// Every refusal status: Google's refusals are read here, whole, since its `error.message` is what googleError rewrites
// and the shared transport's excerpt of a body cuts most of them short.
const ANY_REFUSAL = Array.from({ length: 200 }, (_, index) => 400 + index);

// A download (a Drive file's bytes, an export) may take far longer than a JSON call; this only bounds one that stalls.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

interface Sent {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly spec: CallSpec;
    // How the call is named in a transport error: without its query, which can carry what the user searched for.
    readonly label: string;
}

// One attempt, read whole: the status, the headers (Retry-After), and either the body of a success or the parsed body
// of a refusal, for googleError.
interface Answer<T> {
    readonly status: number;
    readonly headers: Headers;
    readonly body: T | undefined;
    readonly problem: JsonValue | undefined;
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

// A JSON call over base's transport, which holds the deadline and the abort.
const jsonAttempt = async (url: string, sent: Sent): Promise<Answer<JsonValue>> => {
    const { spec } = sent;
    const payload = spec.raw === undefined ? { json: spec.body } : { body: spec.raw.data };
    const answer = await fetchJsonResponse(url, { method: sent.method, headers: sent.headers, ...payload, signal: spec.signal, accept: ANY_REFUSAL, label: sent.label });
    const success = isSuccess(answer.status);
    return { status: answer.status, headers: answer.headers, body: success ? answer.json : undefined, problem: success ? undefined : answer.json };
};

const parsedOrUndefined = (text: string): JsonValue | undefined => parseJsonOr(text, undefined);

// A download's bytes, which are not JSON, so it keeps its own fetch with the same deadline-and-abort pairing.
const bytesAttempt = async (url: string, sent: Sent): Promise<Answer<Buffer>> => {
    const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const signal = sent.spec.signal === undefined ? deadline : AbortSignal.any([sent.spec.signal, deadline]);
    try {
        const response = await fetch(url, { method: sent.method, headers: sent.headers, signal });
        if (isSuccess(response.status)) {
            return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()), problem: undefined };
        }
        return { status: response.status, headers: response.headers, body: undefined, problem: parsedOrUndefined(await response.text()) };
    } catch (error) {
        if (deadline.aborted) {
            throw new Error(`${sent.label} timed out after ${DOWNLOAD_TIMEOUT_MS}ms`, { cause: error });
        }
        throw error;
    }
};

const send = async <T>(session: Session, spec: CallSpec, attempt: (url: string, sent: Sent) => Promise<Answer<T>>): Promise<T | undefined> => {
    const url = withQuery(spec.url, spec.query);
    const method = spec.method ?? "GET";
    const label = `Google ${method} ${spec.url.split("?")[0] ?? spec.url}`;
    let token = await session.token();
    let refreshed = false;
    for (let tries = 1; ; tries += 1) {
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        if (spec.raw !== undefined) {
            headers["content-type"] = spec.raw.contentType;
        }
        const answer = await attempt(url, { method, headers, spec, label });
        if (isSuccess(answer.status)) {
            return answer.body;
        }
        if (answer.status === 401 && !refreshed) {
            refreshed = true;
            token = await session.refresh();
            continue;
        }
        if (RETRY_STATUS.has(answer.status) && tries < MAX_ATTEMPTS) {
            await sleep(retryDelay(tries, answer.headers.get("retry-after")), undefined, spec.signal === undefined ? {} : { signal: spec.signal });
            continue;
        }
        throw googleError(answer.status, url, answer.problem, answer.headers.get("www-authenticate"));
    }
};

// 204 on a delete (and on some Gmail modify endpoints) answers undefined.
export const call = async <T>(session: Session, spec: CallSpec): Promise<T> =>
    // SAFETY: the caller names the shape Google documents for this endpoint; nothing here checks it, as before.
    (await send(session, spec, jsonAttempt)) as T;

export const callBytes = async (session: Session, spec: CallSpec): Promise<Buffer> => (await send(session, spec, bytesAttempt)) ?? Buffer.alloc(0);

// Every Google list endpoint pages the same way and walks forever if nothing stops it; `limit` is required. The
// page-size key differs per API (`maxResults` vs `pageSize`), so it's named per call.
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

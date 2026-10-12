import { errorMessage } from "../errors.js";

// ONE JSON CALL OVER HTTP, AS EVERY TIER MAKES IT: a deadline of its own combined with the caller's signal, the body
// parsed, a refusal's body quoted in the error (bounded, so an HTML error page cannot fill a log), and a timeout told
// apart from a server that could not be reached. The Fly clients reported their own 30-second deadline as "could not be
// reached", the Google client had no deadline and took no abort, and one credential refresh pasted a whole error page
// into its message; each had a copy of this. No schema library here, on purpose: base depends on nothing, so the
// caller validates what comes back with its own schema. `cloudflare.ts` is the same idea for one API's envelope.

// A stalled connection would otherwise block for undici's ~5-minute headers timeout, per call.
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
// Characters of a refusal's body kept in the thrown message.
const ERROR_BODY_CHARS = 300;

// Any JSON value: what a body is until a caller's own schema reads it.
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// Why a call failed, which a caller branches on: a deadline is retried differently from a refusal.
export type FetchFailure = "timeout" | "aborted" | "transport" | "status" | "parse";

export class FetchJsonError extends Error {
    constructor(
        message: string,
        readonly kind: FetchFailure,
        readonly url: string,
        // The HTTP status, for a refusal and for a body that would not parse.
        readonly status?: number,
        // The start of the refusal's body, as text.
        readonly body?: string,
        options?: { readonly cause?: unknown },
    ) {
        super(message, options);
        this.name = "FetchJsonError";
    }
}

export interface FetchJsonInit {
    readonly method?: string;
    readonly headers?: HeadersInit;
    // Sent as JSON, with its content type.
    readonly json?: unknown;
    // Sent as it is, for a form or a body already serialized; `json` wins when both are given.
    readonly body?: BodyInit;
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number;
    // Statuses answered as a result instead of thrown, beyond 2xx (a 404 that means "not there").
    readonly accept?: readonly number[];
    // How the call is named in an error; the method and URL by default. Never put a credential in it.
    readonly label?: string;
    // For tests and for a caller with a fetch of its own (a proxy's).
    readonly fetch?: typeof fetch;
}

export interface JsonResponse {
    readonly status: number;
    readonly headers: Headers;
    // Undefined for an empty body (204, or a 200 with nothing in it).
    readonly json: JsonValue | undefined;
}

const sentInit = (init: FetchJsonInit, signal: AbortSignal): RequestInit => {
    const headers = new Headers(init.headers);
    const sent: RequestInit = { headers, signal };
    if (init.method !== undefined) {
        sent.method = init.method;
    }
    if (init.json !== undefined) {
        if (!headers.has("content-type")) {
            headers.set("content-type", "application/json");
        }
        sent.body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
        sent.body = init.body;
    }
    if (!headers.has("accept")) {
        headers.set("accept", "application/json");
    }
    return sent;
};

// The start of a body, on one line, for an error message.
export const bodyExcerpt = (text: string, limit: number = ERROR_BODY_CHARS): string => {
    const flat = text.replaceAll(/\s+/g, " ").trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

// The failure a thrown fetch or body read stands for: our deadline, the caller's abort, or the network.
const failureOf = (error: Error, label: string, url: string, timeout: AbortSignal, caller: AbortSignal | undefined, timeoutMs: number): FetchJsonError => {
    if (timeout.aborted) {
        return new FetchJsonError(`${label} timed out after ${timeoutMs}ms`, "timeout", url, undefined, undefined, { cause: error });
    }
    if (caller?.aborted === true) {
        return new FetchJsonError(`${label} was aborted`, "aborted", url, undefined, undefined, { cause: error });
    }
    return new FetchJsonError(`${label} could not be reached: ${errorMessage(error)}`, "transport", url, undefined, undefined, { cause: error });
};

// One call with its status: the parsed body of a 2xx (or an accepted status), or a thrown FetchJsonError.
export const fetchJsonResponse = async (url: string | URL, init: FetchJsonInit = {}): Promise<JsonResponse> => {
    const href = String(url);
    const label = init.label ?? `${init.method ?? "GET"} ${href}`;
    const timeoutMs = init.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]);
    const call = init.fetch ?? fetch;
    let response: Response;
    let text: string;
    try {
        response = await call(href, sentInit(init, signal));
        // Read under the same deadline: a server that sends headers and then stalls is as stuck as one that never answers.
        text = await response.text();
    } catch (error) {
        throw failureOf(error instanceof Error ? error : new Error(String(error)), label, href, timeout, init.signal, timeoutMs);
    }
    if (!response.ok && !(init.accept ?? []).includes(response.status)) {
        const excerpt = bodyExcerpt(text);
        throw new FetchJsonError(`${label} failed (HTTP ${response.status})${excerpt === "" ? "" : `: ${excerpt}`}`, "status", href, response.status, excerpt);
    }
    if (text.trim() === "") {
        return { status: response.status, headers: response.headers, json: undefined };
    }
    try {
        // SAFETY: JSON.parse returns only JSON values; the caller's schema narrows it further.
        return { status: response.status, headers: response.headers, json: JSON.parse(text) as JsonValue };
    } catch (error) {
        // An accepted refusal (a 404 page) is answered for its status; its body need not be JSON.
        if (!response.ok) {
            return { status: response.status, headers: response.headers, json: undefined };
        }
        throw new FetchJsonError(`${label} answered something that is not JSON (HTTP ${response.status}): ${bodyExcerpt(text)}`, "parse", href, response.status, bodyExcerpt(text), {
            cause: error,
        });
    }
};

// One call's parsed body, for the caller that needs no status.
export const fetchJson = async (url: string | URL, init: FetchJsonInit = {}): Promise<JsonValue | undefined> => (await fetchJsonResponse(url, init)).json;

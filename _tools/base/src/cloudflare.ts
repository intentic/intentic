import { errorMessage } from "./errors.js";

// THE CLOUDFLARE V4 API, AS EVERY TIER CALLS IT: a bearer token, Cloudflare's success envelope, a 30 s deadline, and
// its paging. The deploy engine's providers (_deploy/providers/src/network/cloudflare-api.ts) and the platform
// (_platform/api/src/sandbox/cloudflare.ts) each kept a copy of this, and only one of them knew a zone out of DNS records
// (81045) from any other refusal. No schema library here, on purpose: base depends on nothing, so the envelope is checked
// by hand and each caller validates `result` with its own schemas.

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

// A stalled connection would otherwise block for undici's ~5-minute headers timeout, per call.
const TIMEOUT_MS = 30_000;

// Cloudflare's error code for a zone that has reached its plan's quota of DNS records.
export const ZONE_OUT_OF_RECORDS = 81_045;

// A refusal Cloudflare answered with: the HTTP status and the envelope's numeric error codes (Cloudflare rewords its
// messages, so a caller that branches reads the codes).
export class CloudflareError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly codes: readonly number[],
    ) {
        super(message);
    }
}

// 401 or 403: the token is invalid, inactive, or lacks the scope the call needs.
export class CloudflareTokenError extends CloudflareError {}

// 81045: the zone has no room for another DNS record, which blocks every record a caller would create in it.
export class CloudflareZoneFullError extends CloudflareError {}

export interface CloudflareInit {
    readonly method?: string;
    // Sent as JSON.
    readonly body?: unknown;
}

// Any JSON value, which is all a Cloudflare body can be: what `result` is until a caller's own schema reads it.
export type CloudflareJson = string | number | boolean | null | readonly CloudflareJson[] | { readonly [key: string]: CloudflareJson };

// A body as it arrives: possibly an envelope, possibly anything else JSON can say.
interface Wire {
    readonly success?: CloudflareJson;
    readonly errors?: CloudflareJson;
    readonly result?: CloudflareJson;
    readonly result_info?: CloudflareJson;
}

// Type aliases rather than interfaces: an object literal type is assignable to JSON's index signature, which is what
// lets the guards below narrow a JSON value to them.
type CloudflareProblem = { readonly code: number; readonly message: string };

type Envelope = {
    readonly success: boolean;
    readonly errors: readonly CloudflareProblem[];
    readonly result: CloudflareJson;
    readonly result_info?: CloudflareJson;
};

const isJsonObject = (value: CloudflareJson | undefined): value is { readonly [key: string]: CloudflareJson } =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isProblem = (error: CloudflareJson): error is CloudflareProblem =>
    isJsonObject(error) && typeof error["code"] === "number" && typeof error["message"] === "string";

const isEnvelope = (body: Wire | null | undefined): body is Envelope =>
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    typeof body.success === "boolean" &&
    Array.isArray(body.errors) &&
    body.errors.every(isProblem);

const hasTotalPages = (info: CloudflareJson | undefined): info is { readonly total_pages: number } =>
    isJsonObject(info) && typeof info["total_pages"] === "number";

// One call: the whole success envelope, or a thrown refusal. Transport failures say how long they took, to tell a
// timeout from an instant refusal.
const request = async (token: string, path: string, init: CloudflareInit = {}): Promise<Envelope> => {
    const label = `Cloudflare API ${init.method ?? "GET"} ${path}`;
    const started = Date.now();
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const sent: RequestInit = { headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (init.method !== undefined) {
        sent.method = init.method;
    }
    if (init.body !== undefined) {
        headers.set("Content-Type", "application/json");
        sent.body = JSON.stringify(init.body);
    }
    let response: Response;
    try {
        response = await fetch(`${CLOUDFLARE_API}${path}`, sent);
    } catch (error) {
        throw new Error(`${label} transport failed after ${Date.now() - started}ms: ${errorMessage(error)}`, { cause: error });
    }
    // A 401/403 may carry no envelope at all, so its body is read for detail and never required. `json()` promises
    // nothing about the shape, which `isEnvelope` establishes before anything is read off it.
    // allow(silent-catch): a body that is not JSON is no envelope, which the checks below read as no detail
    const body: Wire | undefined = await response.json().catch(() => undefined);
    const envelope = isEnvelope(body) ? body : undefined;
    const detail = envelope?.errors.map((error) => `${error.code} ${error.message}`).join("; ") ?? "";
    const codes = envelope?.errors.map((error) => error.code) ?? [];
    if (response.status === 401 || response.status === 403) {
        throw new CloudflareTokenError(`${label} was refused (HTTP ${response.status}): ${detail || "the token is invalid or lacks the scope"}`, response.status, codes);
    }
    if (envelope === undefined) {
        throw new Error(`${label} returned an unexpected response: not Cloudflare's envelope (HTTP ${response.status})`);
    }
    if (!response.ok || !envelope.success) {
        const failed = `${label} failed (HTTP ${response.status}): ${detail}`;
        throw codes.includes(ZONE_OUT_OF_RECORDS)
            ? new CloudflareZoneFullError(`${failed} (the zone is out of DNS records, Cloudflare's per-zone quota)`, response.status, codes)
            : new CloudflareError(failed, response.status, codes);
    }
    return envelope;
};

// One call's `result`, for the caller to validate.
export const cloudflareCall = async (token: string, path: string, init?: CloudflareInit): Promise<CloudflareJson> =>
    (await request(token, path, init)).result;

// Every page of a list endpoint that reports `result_info.total_pages` (zones), concatenated: `path` without paging, each
// page `perPage` long.
export const cloudflarePages = async (token: string, path: string, perPage = 50): Promise<CloudflareJson[]> => {
    const items: CloudflareJson[] = [];
    let page = 1;
    let totalPages = 1;
    do {
        const paged = `${path}${path.includes("?") ? "&" : "?"}per_page=${perPage}&page=${page}`;
        // oxlint-disable-next-line eslint/no-await-in-loop -- each page says whether another exists
        const envelope = await request(token, paged);
        const { result, result_info: info } = envelope;
        if (!Array.isArray(result)) {
            throw new Error(`Cloudflare API GET ${paged} returned an unexpected response: a page that is not a list`);
        }
        items.push(...result);
        // Some list endpoints (cfd_tunnel, dns_records) leave `total_pages` out: one page, then.
        totalPages = hasTotalPages(info) ? info.total_pages : 1;
        page += 1;
    } while (page <= totalPages);
    return items;
};

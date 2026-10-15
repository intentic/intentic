import { z } from "zod";
import type { JsonValue } from "./json.js";

// The one HTTP path both office clients take. Every request: HTTPS only, no redirects (a bearer token or a signed
// assertion must never follow a Location header to a host the card did not name), a deadline, and on failure an error
// that says what the office answered without echoing an identity provider's body, which can quote the credential.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 60_000;

class OfficeHttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "OfficeHttpError";
    }
}

export const httpsUrl = (value: string, what = "address"): URL => {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error(`the card's ${what} is not a URL: "${value}"`);
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
        throw new Error(`the card's ${what} must be an https:// address without credentials in it`);
    }
    return url;
};

// `base` joined with path segments, each percent-encoded, and an optional query.
export const endpoint = (base: string, segments: readonly string[], query?: Readonly<Record<string, string | undefined>>): string => {
    const url = httpsUrl(base);
    const encoded = segments.map((segment) => {
        if (segment === "" || segment === "." || segment === "..") {
            throw new Error(`refusing an empty or relative path segment ("${segment}")`);
        }
        // ":" and "@" may stand unescaped in a path segment (RFC 3986 pchar); an ADE ("AE:PL-…") keeps its colon.
        return encodeURIComponent(segment).replaceAll("%3A", ":").replaceAll("%40", "@");
    });
    if (encoded.length > 0) {
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encoded.join("/")}`;
    }
    for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) {
            url.searchParams.set(key, value);
        }
    }
    return url.href;
};

// An RFC 7807 body (EZD RP) or a UA/SE error list, reduced to its human sentence; never the raw body.
const ProblemSchema = z.object({ title: z.string().optional(), detail: z.string().optional(), message: z.string().optional() });
const UaErrorsSchema = z.array(z.object({ error: z.string().optional(), error_description: z.string().optional() }));
const SeErrorSchema = z.object({ errorCodes: z.array(z.object({ errorCode: z.string(), message: z.string().optional() })) });

const explain = async (response: Response, quoteBody: boolean): Promise<string> => {
    if (!quoteBody) {
        return "";
    }
    const text = await response.text().catch((cause: unknown) => `(the body could not be read: ${cause instanceof Error ? cause.message : "stream error"})`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return text.length > 0 && text.length < 200 ? `: ${text}` : "";
    }
    const problem = ProblemSchema.safeParse(parsed);
    if (problem.success && (problem.data.detail ?? problem.data.title ?? problem.data.message) !== undefined) {
        return `: ${[problem.data.title, problem.data.detail ?? problem.data.message].filter((part) => part !== undefined).join(" — ")}`;
    }
    const ua = UaErrorsSchema.safeParse(parsed);
    if (ua.success && ua.data.length > 0) {
        return `: ${ua.data.map((entry) => [entry.error, entry.error_description].filter((part) => part !== undefined).join(" ")).join("; ")}`;
    }
    const se = SeErrorSchema.safeParse(parsed);
    return se.success ? `: ${se.data.errorCodes.map((entry) => `${entry.errorCode} ${entry.message ?? ""}`.trim()).join("; ")}` : "";
};

export interface RequestOptions {
    // An identity provider's error body is never quoted: it can echo what was sent to it.
    readonly quoteErrors?: boolean;
    readonly accept?: readonly number[];
}

export const request = async (fetcher: Fetch, url: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<Response> => {
    httpsUrl(url);
    const response = await fetcher(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok && !(options.accept ?? []).includes(response.status)) {
        const host = new URL(url).host;
        throw new OfficeHttpError(`${host} answered HTTP ${response.status}${await explain(response, options.quoteErrors !== false)}`, response.status);
    }
    return response;
};

export const jsonInit = (method: string, body: JsonValue, headers: Readonly<Record<string, string>> = {}): RequestInit => ({
    method,
    headers: { ...headers, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
});

// The response body parsed by `schema`, refusing a shape the client was not written for rather than guessing at it.
export const parseJson = async <T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> => {
    const text = await response.text();
    let raw: unknown;
    try {
        raw = text === "" ? {} : JSON.parse(text);
    } catch {
        throw new Error(`${what}: the office answered something that is not JSON`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`${what}: the answer does not have the documented shape (${z.prettifyError(parsed.error).split("\n").slice(0, 3).join("; ")})`);
    }
    return parsed.data;
};

// A short-lived access token, renewed a little before it runs out.
export interface AccessToken {
    readonly value: string;
    readonly expiresAt: number;
}

const TokenResponseSchema = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().optional() });

export const tokenFrom = async (response: Response, now: number): Promise<AccessToken> => {
    const body = await parseJson(response, TokenResponseSchema, "token exchange");
    return { value: body.access_token, expiresAt: now + Math.max(30, (body.expires_in ?? 300) - 30) * 1000 };
};

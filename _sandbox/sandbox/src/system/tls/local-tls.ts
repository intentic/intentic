import { nodeRequest } from "./node-request.js";

// Only hosts this daemon may skip certificate verification for (a self-signed dev platform on
// localhost/host.docker.internal); centralized so every caller agrees, and never configurable.
export const isLocalHost = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "host.docker.internal";

// 204/304 must carry no body; Response refuses one, and any status below 200 isn't accepted either.
const bodiless = (status: number): boolean => status === 204 || status === 304;

// fetch-shaped wrapper for the one thing undici can't do per-request: skip verification on a self-signed local host.
// Everything else passes through the real fetch untouched. Cast because callers want the call signature, not the
// `preconnect` bun-types hangs off the global.
export const localTolerantFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.protocol !== "https:" || !isLocalHost(url.hostname)) {
        return fetch(input, init);
    }
    const body = init?.body;
    const answer = await nodeRequest(url, {
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        // Only the bodies its callers send; a stream or a form never came through here.
        body: typeof body === "string" || body instanceof Uint8Array ? body : undefined,
        insecure: true,
        // Uses the caller's own deadline (each sets an AbortSignal.timeout) rather than inventing a second one.
        signal: init?.signal ?? undefined,
    });
    return new Response(bodiless(answer.status) ? null : answer.body, { status: answer.status < 200 ? 502 : answer.status });
}) as unknown as typeof fetch;

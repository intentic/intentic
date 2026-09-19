import type { Context } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";

// HTTP/1.1 host headers (Connection, Keep-Alive) abort an HTTP/2 response if forwarded untouched; strip both
// directions.
// `Connection` may list further hop-by-hop fields, so read it before removing this fixed set.
const HOP_BY_HOP_HEADERS = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
] as const;

const endToEndHeaders = (source: Headers): Headers => {
    const headers = new Headers(source);
    for (const token of headers.get("connection")?.split(",") ?? []) {
        const name = token.trim();
        if (name !== "") {
            headers.delete(name);
        }
    }
    for (const name of HOP_BY_HOP_HEADERS) {
        headers.delete(name);
    }
    return headers;
};

// The browser multiplexes every daemon call onto one HTTP/2 connection, so requests still waiting for their first byte
// hold streams the rest of the daemon shares: enough of them and /events and /system/* queue behind one extension.
// Counted per extension and only while headers are outstanding — a response that has started arriving is long-lived by
// design, not a stall.
const WAITING_PER_EXTENSION = 6;

// A call only counts against that cap once it has been waiting longer than any round trip takes. Without this the cap
// is a concurrency limit, and an extension whose panel fans out a dozen quick reads would be shed for being busy.
const COUNTS_AS_STALLED_MS = 2_000;

// Shorter than the browser's own deadline (sandboxAuthFetch.ts), so a handler that never answers is named here rather
// than abandoned there with nothing to attribute it to. Covers time-to-headers only; the body may then take as long as
// it likes.
const HEADERS_DEADLINE_MS = 20_000;

// Extension whose namespace this path addresses; `/x/<id>/…` is the only shape this route is mounted on.
const extensionOf = (pathname: string): string => decodeURIComponent(/^\/x\/([^/]+)/.exec(pathname)?.[1] ?? "");

// Machine-readable alongside the sentence: the browser names the extension and route in what it shows, rather than
// reporting the sandbox itself as slow.
const stall = (extension: string, path: string, error: string) => ({ error, extension, path });

// One entry per call still waiting on its first byte. Identity, not a count: calls for one extension overlap by
// definition, and a number decremented by whichever finishes first drifts from what is actually in flight.
type WaitingCall = { readonly at: number };

const stalledCount = (calls: ReadonlySet<WaitingCall>, now: number): number => {
    let stalled = 0;
    for (const call of calls) {
        stalled += now - call.at >= COUNTS_AS_STALLED_MS ? 1 : 0;
    }
    return stalled;
};

const forward = async (c: Context<AppEnv>, target: { port: number; hostToken: string }, url: URL, extension: string): Promise<Response> => {
    const headers = endToEndHeaders(c.req.raw.headers);
    headers.delete("authorization");
    headers.set("x-intentic-backend", target.hostToken);
    const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body;
    const stalled = new AbortController();
    const deadline = setTimeout(() => stalled.abort(), HEADERS_DEADLINE_MS);
    try {
        const upstream = await fetch(`http://127.0.0.1:${target.port}${url.pathname}${url.search}`, {
            method: c.req.method,
            headers,
            signal: stalled.signal,
            ...(body !== undefined && body !== null ? { body, duplex: "half" } : {}),
        } as RequestInit);
        return new Response(upstream.body, { status: upstream.status, headers: endToEndHeaders(upstream.headers) });
    } catch (error) {
        if (!stalled.signal.aborted) {
            throw error;
        }
        return c.json(stall(extension, url.pathname, `${extension} did not answer ${url.pathname} within ${HEADERS_DEADLINE_MS / 1000}s`), 504);
    } finally {
        // Cleared on the way out either way: past headers the deadline would cut a legitimate stream mid-body.
        clearTimeout(deadline);
    }
};

// Proxies /x/<id>/* verbatim to the backend host; the request already passed the boot gate, CORS and bearer role floor.
// Credentials are stripped before forwarding, the backend authenticates only with its own scoped token; 503 during a
// restart is the client's retry cue.
export const createBackendProxyRoute = (services: Pick<Services, "extensionBackend">) => {
    // Per route, not per request: the cap is only a cap if every call in flight counts against the same set.
    const waiting = new Map<string, Set<WaitingCall>>();
    return async (c: Context<AppEnv>): Promise<Response> => {
        const target = services.extensionBackend.proxyTarget();
        if (target === undefined) {
            const backend = services.extensionBackend.status();
            return c.json({ error: `extension backends are ${backend.state}${backend.detail !== undefined ? `, ${backend.detail}` : ""}` }, 503);
        }
        const url = new URL(c.req.url);
        const extension = extensionOf(url.pathname);
        const calls = waiting.get(extension) ?? new Set<WaitingCall>();
        const stalled = stalledCount(calls, Date.now());
        if (stalled >= WAITING_PER_EXTENSION) {
            const refusal = `${extension} has ${stalled} requests that have been waiting seconds for a first byte, so this one was refused rather than queued behind them`;
            return c.json(stall(extension, url.pathname, refusal), 503);
        }
        const call: WaitingCall = { at: Date.now() };
        calls.add(call);
        waiting.set(extension, calls);
        try {
            return await forward(c, target, url, extension);
        } finally {
            calls.delete(call);
            if (calls.size === 0) {
                waiting.delete(extension);
            }
        }
    };
};

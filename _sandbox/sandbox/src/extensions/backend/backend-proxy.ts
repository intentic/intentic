import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { BACKEND_CARD_HEADER, BACKEND_HOST_HEADER } from "./backend-host-config.js";

// One request forwarded to the extension backend host: the /x/<id>/* route (backend-proxy.routes.ts) and the MCP door
// (extension-mcp.ts) both go through it, so neither has to import the other's layer to reach a backend.

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

// Shorter than the browser's own deadline (sandboxAuthFetch.ts), so a handler that never answers is named here rather
// than abandoned there with nothing to attribute it to. Covers time-to-headers only; the body may then take as long as
// it likes.
const HEADERS_DEADLINE_MS = 20_000;

// Machine-readable alongside the sentence: the browser names the extension and route in what it shows, rather than
// reporting the sandbox itself as slow.
export const stall = (extension: string, path: string, error: string) => ({ error, extension, path });

// Also the MCP door's way in to an extension (extension-mcp.ts), with `url` rewritten onto the card's path and a
// deadline of its own. Whatever credential or daemon-only header the caller sent is dropped; only `target.headers`
// (the host token, a door's card) go on.
export const forwardToBackend = async (
    c: Context<AppEnv>,
    target: { readonly port: number; readonly headers: Readonly<Record<string, string>> },
    url: URL,
    extension: string,
    headersDeadlineMs = HEADERS_DEADLINE_MS,
): Promise<Response> => {
    const headers = endToEndHeaders(c.req.raw.headers);
    for (const name of ["authorization", BACKEND_HOST_HEADER, BACKEND_CARD_HEADER]) {
        headers.delete(name);
    }
    for (const [name, value] of Object.entries(target.headers)) {
        headers.set(name, value);
    }
    const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body;
    const stalled = new AbortController();
    const deadline = setTimeout(() => stalled.abort(), headersDeadlineMs);
    // Node's fetch streams a request body only with `duplex: "half"`, which the DOM's RequestInit does not declare.
    const init: RequestInit & { duplex?: "half" } = { method: c.req.method, headers, signal: stalled.signal };
    if (body !== undefined && body !== null) {
        init.body = body;
        init.duplex = "half";
    }
    try {
        const upstream = await fetch(`http://127.0.0.1:${target.port}${url.pathname}${url.search}`, init);
        return new Response(upstream.body, { status: upstream.status, headers: endToEndHeaders(upstream.headers) });
    } catch (error) {
        if (!stalled.signal.aborted) {
            throw error;
        }
        return c.json(stall(extension, url.pathname, `${extension} did not answer ${url.pathname} within ${headersDeadlineMs / 1000}s`), 504);
    } finally {
        // Cleared on the way out either way: past headers the deadline would cut a legitimate stream mid-body.
        clearTimeout(deadline);
    }
};

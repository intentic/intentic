import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { CONNECT_TOKEN_HEADER, EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/protocol/headers";
import { EXTENSION_CALLER_HEADER, PUBLIC_DOOR_HEADER } from "@intentic/sandbox-contract/extension-protocol";
import { forwardHeaders, REQUEST_REFRAMED, RESPONSE_REFRAMED } from "../../http/forward-headers.js";
import { BACKEND_CARD_HEADER, BACKEND_HOST_HEADER } from "./backend-host-config.js";

// One request forwarded to the extension backend host: the /x/<id>/* route (backend-proxy.routes.ts) and the MCP door
// (extension-mcp.ts) both go through it, so neither has to import the other's layer to reach a backend.

// HTTP/1.1 connection headers (Connection, Keep-Alive and the rest of the hop-by-hop set) abort an HTTP/2 response if
// forwarded untouched, so both directions go through forwardHeaders. fetch decodes a gzip or br answer itself and frames
// the request body again, so the encoding and length headers of either side no longer describe the bytes relayed.

// Shorter than the browser's own deadline (sandboxAuthFetch.ts), so a handler that never answers is named here rather
// than abandoned there with nothing to attribute it to. Covers time-to-headers only; the body may then take as long as
// it likes.
const HEADERS_DEADLINE_MS = 20_000;

// Machine-readable alongside the sentence: the browser names the extension and route in what it shows, rather than
// reporting the sandbox itself as slow.
export const stall = (extension: string, path: string, error: string) => ({ error, extension, path });

// Every credential a caller may present to the daemon (the bearer, a session cookie, each grant's header and the
// connect token) and every header only the daemon may set for a backend (the host token, a door's card, the caller's
// assertion, a public door's verification): none of them reaches an extension's code from the caller. (2026-11-26) Only
// `authorization` was dropped before, so a panel's or a control token's own header rode on into the backend.
const NEVER_FORWARDED: readonly string[] = [
    "authorization",
    "cookie",
    "x-intentic-panel",
    "x-intentic-agent",
    "x-intentic-control",
    "x-intentic-sync",
    EXTENSION_TOKEN_HEADER,
    CONNECT_TOKEN_HEADER,
    BACKEND_HOST_HEADER,
    BACKEND_CARD_HEADER,
    EXTENSION_CALLER_HEADER,
    PUBLIC_DOOR_HEADER,
];

export interface BackendTarget {
    readonly port: number;
    // What the daemon sets on the way (the host token, a door's card, the caller's assertion, a door's verification).
    readonly headers: Readonly<Record<string, string>>;
    // A body the daemon already read and checked (a public door's), sent in place of the caller's stream.
    readonly body?: Uint8Array<ArrayBuffer> | string | undefined;
}

// Also the MCP door's and the public doors' way in to an extension (extension-mcp.ts, public-door.routes.ts), with `url`
// rewritten onto the path the door answers and a deadline of its own. Whatever credential or daemon-only header the
// caller sent is dropped (NEVER_FORWARDED); only `target.headers` go on.
export const forwardToBackend = async (c: Context<AppEnv>, target: BackendTarget, url: URL, extension: string, headersDeadlineMs = HEADERS_DEADLINE_MS): Promise<Response> => {
    const headers = forwardHeaders(c.req.raw.headers, [...REQUEST_REFRAMED, ...NEVER_FORWARDED]);
    for (const [name, value] of Object.entries(target.headers)) {
        headers.set(name, value);
    }
    const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : (target.body ?? c.req.raw.body);
    const stalled = new AbortController();
    const deadline = setTimeout(() => stalled.abort(), headersDeadlineMs);
    // Node's fetch streams a request body only with `duplex: "half"`, which the DOM's RequestInit does not declare.
    // Redirects belong to the caller: following one here would send the host token and resolved card secrets to its
    // destination. The caller's abort stays attached after headers too, so leaving a stream closes the backend call.
    const init: RequestInit & { duplex?: "half" } = {
        method: c.req.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.any([c.req.raw.signal, stalled.signal]),
    };
    if (body !== undefined && body !== null) {
        init.body = body;
        init.duplex = "half";
    }
    try {
        const upstream = await fetch(`http://127.0.0.1:${target.port}${url.pathname}${url.search}`, init);
        return new Response(upstream.body, { status: upstream.status, headers: forwardHeaders(upstream.headers, RESPONSE_REFRAMED) });
    } catch (error) {
        if (c.req.raw.signal.aborted || !stalled.signal.aborted) {
            throw error;
        }
        return c.json(stall(extension, url.pathname, `${extension} did not answer ${url.pathname} within ${headersDeadlineMs / 1000}s`), 504);
    } finally {
        // Cleared on the way out either way: past headers the deadline would cut a legitimate stream mid-body.
        clearTimeout(deadline);
    }
};

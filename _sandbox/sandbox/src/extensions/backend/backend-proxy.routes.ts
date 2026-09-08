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

// Proxies /x/<id>/* verbatim to the backend host; the request already passed the boot gate, CORS and bearer role floor.
// Credentials are stripped before forwarding, the backend authenticates only with its own scoped token; 503 during a
// restart is the client's retry cue.
export const createBackendProxyRoute =
    (services: Pick<Services, "extensionBackend">) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const target = services.extensionBackend.proxyTarget();
        if (target === undefined) {
            const backend = services.extensionBackend.status();
            return c.json({ error: `extension backends are ${backend.state}${backend.detail !== undefined ? `, ${backend.detail}` : ""}` }, 503);
        }
        const url = new URL(c.req.url);
        const headers = endToEndHeaders(c.req.raw.headers);
        headers.delete("authorization");
        headers.set("x-intentic-backend", target.hostToken);
        const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body;
        const upstream = await fetch(`http://127.0.0.1:${target.port}${url.pathname}${url.search}`, {
            method: c.req.method,
            headers,
            ...(body !== undefined && body !== null ? { body, duplex: "half" } : {}),
        } as RequestInit);
        return new Response(upstream.body, { status: upstream.status, headers: endToEndHeaders(upstream.headers) });
    };

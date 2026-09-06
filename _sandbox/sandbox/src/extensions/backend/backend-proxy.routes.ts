import type { Context } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";

/* Headers about ONE transport connection cannot cross the extension-backend proxy. The child host speaks
 * HTTP/1.1, whose server adds `Connection: keep-alive` and `Keep-Alive` to every answer; the browser-facing
 * loopback listener speaks HTTP/2, where Node refuses those fields and aborts the response before its body can
 * reach the browser. `Connection` may name additional hop-by-hop fields, so discover those before removing the
 * standard set. Apply the same boundary in both directions: HTTP/1 fallback clients can send them too. */
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

/* Extension backend namespaces: /x/<id>/* proxied verbatim to the backend host (extensions/backend/).
 * The request has already been through everything above it in app.ts: the boot gate, CORS, and the bearer
 * middleware with its role floor (an unlisted GET floors at viewer, an unlisted mutation at maintainer, the
 * same defaults every unclassified core route gets). What is forwarded is the request MINUS its credentials:
 * the backend acts on the daemon through its own scoped token, and handing it the owner's bearer would
 * quietly re-grant everything the token model just took away. A host mid-restart answers 503 with the
 * supervisor's own words, which is the web's cue to retry rather than to render an error state. */
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

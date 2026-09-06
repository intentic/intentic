import type { Context } from "hono";
import type { Caller } from "./auth/auth.js";
import type { Principal } from "./auth/principal.js";

// The Hono env: the bearer middleware stashes the caller's verified identity so the oRPC context below can
// carry it to handlers (presence needs to know WHO is connected). Middleware-exempt paths, panel-token
// callers, and loopback mode leave it unset, those callers have no member identity to show. A grant that names
// a party (a control token) stashes a principal instead (auth/principal.ts): no member identity, but a name the
// work can be attributed to.
export interface AppEnv {
    Variables: { identity?: Caller; principal?: Principal };
}

// Per-request context handed to every oRPC handler. Auth + CORS run as Hono middleware ahead of the oRPC
// catch-all (the daemon owns its own auth), so handlers need nothing beyond the raw request metadata and the
// verified identity, mirroring the platform/verification-api OrpcContext. The request's AbortSignal reaches
// streaming handlers through oRPC's own `signal` handler option, not this context.
export interface OrpcContext {
    headers: Headers;
    method: string;
    url: string;
    identity?: Caller;
    principal?: Principal;
}

export const buildOrpcContext = (c: Context<AppEnv>): OrpcContext => {
    const url = new URL(c.req.url);
    const identity = c.get("identity");
    const principal = c.get("principal");
    return {
        headers: c.req.raw.headers,
        method: c.req.method,
        url: url.pathname + url.search,
        ...(identity !== undefined ? { identity } : {}),
        ...(principal !== undefined ? { principal } : {}),
    };
};

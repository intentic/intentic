import type { Context } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { BACKEND_HOST_HEADER } from "./backend-host-config.js";
import { forwardToBackend, stall } from "./backend-proxy.js";

// The browser multiplexes every daemon call onto one HTTP/2 connection, so requests still waiting for their first byte
// hold streams the rest of the daemon shares: enough of them and /events and /system/* queue behind one extension.
// Counted per extension and only while headers are outstanding — a response that has started arriving is long-lived by
// design, not a stall.
const WAITING_PER_EXTENSION = 6;

// A call only counts against that cap once it has been waiting longer than any round trip takes. Without this the cap
// is a concurrency limit, and an extension whose panel fans out a dozen quick reads would be shed for being busy.
const COUNTS_AS_STALLED_MS = 2_000;

// Extension whose namespace this path addresses; `/x/<id>/…` is the only shape this route is mounted on.
const extensionOf = (pathname: string): string => decodeURIComponent(/^\/x\/([^/]+)/.exec(pathname)?.[1] ?? "");

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

// Proxies /x/<id>/* verbatim to the backend host; the request already passed the boot gate, CORS and bearer role floor.
// Credentials are stripped before forwarding, the backend authenticates only with its own scoped token; 503 during a
// restart is the client's retry cue. An extension's declared MCP endpoint is refused here: it is reached only through the
// daemon's MCP door, which checks that the calling turn was granted the card, never by a panel's or a member's bearer.
export const createBackendProxyRoute = (services: Pick<Services, "extensionBackend">) => {
    // Per route, not per request: the cap is only a cap if every call in flight counts against the same set.
    const waiting = new Map<string, Set<WaitingCall>>();
    return async (c: Context<AppEnv>): Promise<Response> => {
        const url = new URL(c.req.url);
        if (services.extensionBackend.isToolPath(url.pathname)) {
            return c.json({ error: "an extension's MCP endpoint is reached only through a turn's MCP mount, not /x" }, 403);
        }
        const target = services.extensionBackend.proxyTarget();
        if (target === undefined) {
            const backend = services.extensionBackend.status();
            return c.json({ error: `extension backends are ${backend.state}${backend.detail !== undefined ? `, ${backend.detail}` : ""}` }, 503);
        }
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
            return await forwardToBackend(c, { port: target.port, headers: { [BACKEND_HOST_HEADER]: target.hostToken } }, url, extension);
        } finally {
            calls.delete(call);
            if (calls.size === 0) {
                waiting.delete(extension);
            }
        }
    };
};

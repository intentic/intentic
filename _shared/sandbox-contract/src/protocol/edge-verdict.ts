// Why the edge could not carry a request to a sandbox, in words a browser may read. The edge is the only party that
// can tell "this box is not dialled in" from "your network is down", and a cross-origin error is invisible to
// JavaScript unless the responder allows it — so the verdict rides an exposed header and the edge CORS-allows its own
// errors. Ingress writes it, the editor's connection machine reads it; both sides import this file so they cannot drift.

import type { EdgeVerdict } from "../front/generated/browser-wire.js";

export const EDGE_VERDICT_HEADER = "x-intentic-edge";

// The verdicts themselves are the edge's (browser-wire's `EdgeVerdict`), each documented there:
// - no-tunnel: no tunnel is registered for this sandbox, and retrying is right, since a container that comes back redials
//   within seconds;
// - unknown-sandbox: the platform has no such sandbox, and nothing the reader waits for can change that;
// - dropped: a tunnel was held and the forward failed mid-flight.
export type { EdgeVerdict };

// Every verdict, so a new one in the Rust enum fails this file's typecheck until it is read here too.
const VERDICTS: ReadonlySet<string> = new Set(
    Object.keys({ "no-tunnel": true, "unknown-sandbox": true, dropped: true } satisfies Record<EdgeVerdict, true>),
);

// A header value only counts when it is one of ours: a 502 from anything else on the path (a corporate proxy, a CDN)
// carries no verdict and must not be read as one.
export const edgeVerdictOf = (value: string | null | undefined): EdgeVerdict | undefined =>
    typeof value === "string" && VERDICTS.has(value) ? (value as EdgeVerdict) : undefined;

// Whether a sandbox can still come back on its own, which decides whether the reader is told to wait or told to act.
export const edgeVerdictIsFinal = (verdict: EdgeVerdict): boolean => verdict === "unknown-sandbox";

// The edge's own error responses, and only those, are readable by any origin: each carries one constant sentence, no
// credential is ever accepted on them, and nothing in them is per-reader — so `*` discloses nothing a stranger could
// not get by dialling the hostname itself. A live sandbox's CORS still comes from the daemon, proxied untouched.
export const edgeErrorHeaders = (verdict: EdgeVerdict): Readonly<Record<string, string>> => ({
    [EDGE_VERDICT_HEADER]: verdict,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "*",
    "access-control-allow-headers": "*",
    // Without this the header above exists on the wire and is unreadable in the browser, which is the whole bug.
    "access-control-expose-headers": EDGE_VERDICT_HEADER,
    // A preflight is not an answer a browser may cache long: the sandbox this refuses is expected back.
    "access-control-max-age": "60",
});

// Whether this request is a CORS preflight, which must be answered 2xx or the real request is never sent — and the real
// request is the one that can carry the verdict to JavaScript.
export const isCorsPreflight = (method: string | undefined, requestMethodHeader: string | string[] | undefined): boolean =>
    method === "OPTIONS" && requestMethodHeader !== undefined;

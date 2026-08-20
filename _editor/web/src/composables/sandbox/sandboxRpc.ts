import { sandboxContract } from "@intentic/sandbox-contract";
import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink, type OpenAPILinkOptions } from "@orpc/openapi-client/fetch";
import { useEndpoint } from "./useEndpoint";
import { trackPerf } from "../perf";
import { sandboxAuthenticatedFetch, SandboxUnaddressedError } from "./sandboxAuthFetch";

/* The TYPED client for the active sandbox daemon, derived from the same `sandboxContract` the daemon
 * implements, the daemon-side twin of useApi's platform client.
 *
 * The daemon has always declared its streams as oRPC `eventIterator(...)` procedures (system.events,
 * agent.attach, intentic.applyEvents, capabilities.add, vpn.*): schema-validated on the way out, typed on the
 * way in. What was missing was a CLIENT that spoke it, every browser call went through `sandboxRequest`'s raw
 * fetch, so each stream consumer re-derived the SSE framing by hand and then re-validated the frames it had
 * just discarded the types of. This client removes that round trip: `@orpc/openapi-client` decodes an
 * `text/event-stream` response back into the contract's async iterator, so a consumer awaits typed frames.
 *
 * Auth is identical to sandboxRequest, a per-call daemon-session bearer (useSandboxSession) plus the TOFU
 * connect token, because both option hooks accept a function and are evaluated per request, which is what
 * lets one long-lived client follow a switched sandbox and a refreshed credential without being rebuilt.
 *
 * `sandboxRequest` stays for the non-contract surface it is the only way to reach: the hand-written Hono
 * routes (/health, /workspace/raw), the chunked XHR upload path, and the extension host's deliberately
 * path-based data plane (an extension bundle cannot import our contract). */

const { daemonBase } = useEndpoint();
export { SandboxUnaddressedError } from "./sandboxAuthFetch";

// Everything about reaching the daemon that does NOT depend on who is asking: the base, the credentials, the
// clock. Shared by every client built below, which is what makes an extension's reach identical to the app's
// in all respects but the gate.
const linkOptions: OpenAPILinkOptions<Record<never, never>> = {
    // Resolved per request rather than captured at construction: the link is built once at module load,
    // and a fetch bound then is invisible to anything that replaces it afterwards (a test's stub, an
    // instrumentation wrapper). No credentials, the daemon is cross-origin and bearer-authed, never cookied.
    //
    // The hook is also where every typed call gets its clock. Same `rpc.request` op as sandboxClient's raw
    // fetch, so one table row covers both ways of reaching the daemon; the path is the URL's, minus origin
    // and query, so a route aggregates instead of splitting per file/repo argument. A stream's span ends at
    // the response HEADERS, not at the last frame, which is the right measure for /events and the attach:
    // what matters there is how long the connection took to establish.
    fetch: (request) => {
        const path = ((): string => {
            try {
                return new URL(request.url).pathname;
            } catch {
                return request.url;
            }
        })();
        return trackPerf(`rpc.request`, { path, method: request.method }, () => sandboxAuthenticatedFetch(request));
    },
    // Read per request, not captured: a sandbox switch (or a daemon that re-announced a new URL after a
    // restart) must be picked up by the very next call, with no client rebuild. Same reason the loopback
    // shortcut can be adopted mid-session, this hook simply starts returning the faster base.
    url: () => {
        const base = daemonBase.value;
        if (base === undefined || base === ``) {
            throw new SandboxUnaddressedError();
        }
        return base;
    },
    // sandboxAuthenticatedFetch adds both credentials from one immutable target snapshot.
    headers: () => ({}),
};

// The app's own client, ungated, because the app IS the host.
export const sandboxRpc: ContractRouterClient<typeof sandboxContract> = createORPCClient(new OpenAPILink(sandboxContract, linkOptions));

/* THE SAME CLIENT, ANSWERABLE TO A MANIFEST, one instance per extension, for the extension host.
 *
 * The gate runs before the request is built, receives the procedure the caller named and the input it passed,
 * and throws to refuse; returning is consent. That is the whole difference between this and the app's own
 * client, and it is deliberately the only one: an extension reaches the daemon exactly as the app does, over
 * the same base with the same credentials, and cannot reach it any other way.
 *
 * Interception at the PROCEDURE, not at the request, is what makes the gate exact. A path-based guard has to
 * recover the caller's intent from a formatted URL; here the contract has already named it. */
export const gatedSandboxRpc = (gate: (procedure: readonly string[], input: unknown) => void): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(
        new OpenAPILink(sandboxContract, {
            ...linkOptions,
            interceptors: [
                ({ path, input, next }) => {
                    gate(path, input);
                    return next();
                },
            ],
        }),
    );

// The HTTP status behind a failed daemon call, or undefined when the call never got an answer (DNS, TLS, a
// dead tunnel, an abort). oRPC maps every non-2xx to an ORPCError carrying the status, including the daemon's
// hand-written `{ error }` bodies, which are not oRPC-shaped and land in the malformed-response branch.
export const daemonErrorStatus = (error: unknown): number | undefined => {
    if (error instanceof ORPCError) {
        return error.status;
    }
    if (typeof error === `object` && error !== null && `status` in error && typeof error.status === `number`) {
        return error.status;
    }
    return undefined;
};

// The daemon's user-facing text for a failed call. oRPC handlers put it on the error's own `message`; the
// hand-written routes answer `{ error }`, which arrives as the undecoded body under `data`.
export const daemonErrorMessage = (error: unknown): string => {
    if (error instanceof ORPCError) {
        const body = (error.data as { body?: { error?: unknown; message?: unknown } } | undefined)?.body;
        const detail = body?.error ?? body?.message;
        if (typeof detail === `string` && detail !== ``) {
            return detail;
        }
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
};

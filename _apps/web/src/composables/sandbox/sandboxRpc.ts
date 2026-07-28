import { sandboxContract } from "@intentic/sandbox-contract";
import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { useSandboxSession } from "./sandboxSession";
import { useSandbox } from "./useSandbox";

/* The TYPED client for the active sandbox daemon, derived from the same `sandboxContract` the daemon
 * implements — the daemon-side twin of useApi's platform client.
 *
 * The daemon has always declared its streams as oRPC `eventIterator(...)` procedures (system.events,
 * agent.attach, intentic.applyEvents, capabilities.add, vpn.*): schema-validated on the way out, typed on the
 * way in. What was missing was a CLIENT that spoke it — every browser call went through `sandboxRequest`'s raw
 * fetch, so each stream consumer re-derived the SSE framing by hand and then re-validated the frames it had
 * just discarded the types of. This client removes that round trip: `@orpc/openapi-client` decodes an
 * `text/event-stream` response back into the contract's async iterator, so a consumer awaits typed frames.
 *
 * Auth is identical to sandboxRequest — a per-call daemon-session bearer (useSandboxSession) plus the TOFU
 * connect token — because both option hooks accept a function and are evaluated per request, which is what
 * lets one long-lived client follow a switched sandbox and a refreshed credential without being rebuilt.
 *
 * `sandboxRequest` stays for the non-contract surface it is the only way to reach: the hand-written Hono
 * routes (/health, /workspace/raw), the chunked XHR upload path, and the extension host's deliberately
 * path-based data plane (an extension bundle cannot import our contract). */

const { active, daemonUrl } = useSandbox();
const { getSessionToken } = useSandboxSession();

// The active sandbox has no address yet (setup unfinished, or the daemon has not announced itself). Its own
// class because the connection supervisor treats it as a distinct, non-retryable-by-reconnect condition —
// there is nothing to reconnect TO until the platform hands us a URL.
export class SandboxUnaddressedError extends Error {
    constructor() {
        super(`Your sandbox isn't reachable yet — finish setup so it registers its address.`);
    }
}

export const sandboxRpc: ContractRouterClient<typeof sandboxContract> = createORPCClient(
    new OpenAPILink(sandboxContract, {
        // Resolved per request rather than captured at construction: the link is built once at module load,
        // and a fetch bound then is invisible to anything that replaces it afterwards (a test's stub, an
        // instrumentation wrapper). No credentials — the daemon is cross-origin and bearer-authed, never cookied.
        fetch: (request) => globalThis.fetch(request),
        // Read per request, not captured: a sandbox switch (or a daemon that re-announced a new URL after a
        // restart) must be picked up by the very next call, with no client rebuild.
        url: () => {
            const base = daemonUrl.value;
            if (base === undefined || base === ``) {
                throw new SandboxUnaddressedError();
            }
            return base;
        },
        headers: async () => {
            const token = await getSessionToken();
            if (token === undefined) {
                throw new Error(`Sign in with Google to reach your sandbox.`);
            }
            const connectToken = active.value?.token;
            return {
                authorization: `Bearer ${token}`,
                // The daemon binds its owner on the FIRST authenticated request (TOFU) only if it carries the
                // sandbox's connect token; it ignores the header once bound, so sending it always is harmless.
                ...(connectToken !== undefined ? { "x-intentic-connect": connectToken } : {}),
            };
        },
    }),
);

// The HTTP status behind a failed daemon call, or undefined when the call never got an answer (DNS, TLS, a
// dead tunnel, an abort). oRPC maps every non-2xx to an ORPCError carrying the status — including the daemon's
// hand-written `{ error }` bodies, which are not oRPC-shaped and land in the malformed-response branch.
export const daemonErrorStatus = (error: unknown): number | undefined => (error instanceof ORPCError ? error.status : undefined);

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

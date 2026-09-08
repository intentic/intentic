import { errorMessage } from "@intentic/base/errors";
import { REQUEST_ID_EVIDENCE_ROUTE, REQUEST_ID_HEADER, sandboxContract } from "@intentic/sandbox-contract";
import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink, type OpenAPILinkOptions } from "@orpc/openapi-client/fetch";
import { useEndpoint } from "../secrets/useEndpoint";
import { trackPerf } from "../../../app/perf";
import { uuid } from "../../../lib/uuid";
import { routeAdvertised } from "../overview/useDaemonRoutes";
import { sandboxAuthenticatedFetch, SandboxUnaddressedError } from "./sandboxAuthFetch";

// The typed oRPC client for the active sandbox daemon; decodes its event-stream procedures into typed frames
// instead of hand-rolled SSE. Auth matches sandboxRequest, resolved per request so one client follows a switched
// sandbox. sandboxRequest remains for routes with no contract: hand-written Hono routes, chunked upload, the
// extension host.

const { daemonBase } = useEndpoint();
export { SandboxUnaddressedError } from "./sandboxAuthFetch";

// Reaching the daemon, independent of caller: base, credentials, clock; shared by every client below.
const linkOptions: OpenAPILinkOptions<Record<never, never>> = {
    // Resolved per request, not captured at construction, so a fetch replaced later (a test stub, instrumentation)
    // still applies. Also where every typed call gets timed, on the same rpc.request span sandboxClient's raw fetch
    // uses.
    fetch: (request) => {
        const path = ((): string => {
            try {
                return new URL(request.url).pathname;
            } catch {
                return request.url;
            }
        })();
        // Correlates this call with the daemon's own http.request line. Sent only once the daemon has advertised
        // support:
        // unconditionally, it forces a CORS preflight that fails the whole request on an older daemon.
        const requestId = routeAdvertised(REQUEST_ID_EVIDENCE_ROUTE) === true ? uuid() : undefined;
        const headers = new Headers(request.headers);
        if (requestId !== undefined) {
            headers.set(REQUEST_ID_HEADER, requestId);
        }
        return trackPerf(`rpc.request`, { path, method: request.method, requestId }, () =>
            sandboxAuthenticatedFetch(new Request(request, { headers })),
        );
    },
    // Read per request, not captured, so a sandbox switch or daemon relocation is picked up on the very next call.
    url: () => {
        const base = daemonBase.value;
        if (base === undefined || base === ``) {
            throw new SandboxUnaddressedError();
        }
        return base;
    },
    // sandboxAuthenticatedFetch adds both credentials from an immutable target snapshot.
    headers: () => ({}),
};

// The app's own client, ungated, since the app is the host itself.
export const sandboxRpc: ContractRouterClient<typeof sandboxContract> = createORPCClient(new OpenAPILink(sandboxContract, linkOptions));

// One client per extension, gated at the procedure rather than the request: the gate sees the named procedure
// and input directly, and throws to refuse.
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

// The HTTP status behind a failed call, or undefined when it never got an answer (DNS, TLS, a dead tunnel, an
// abort). oRPC maps every non-2xx to an ORPCError, including the daemon's hand-written `{ error }` bodies.
export const daemonErrorStatus = (error: unknown): number | undefined => {
    if (error instanceof ORPCError) {
        return error.status;
    }
    if (typeof error === `object` && error !== null && `status` in error && typeof error.status === `number`) {
        return error.status;
    }
    return undefined;
};

// The daemon's user-facing text for a failed call: oRPC handlers put it on the error's own message; hand-written
// routes answer `{ error }`, arriving undecoded under `data`.
export const daemonErrorMessage = (error: unknown): string => {
    if (error instanceof ORPCError) {
        const body = (error.data as { body?: { error?: unknown; message?: unknown } } | undefined)?.body;
        const detail = body?.error ?? body?.message;
        if (typeof detail === `string` && detail !== ``) {
            return detail;
        }
        return error.message;
    }
    return errorMessage(error);
};

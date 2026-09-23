import { errorMessage } from "@intentic/base/errors";
import { REQUEST_ID_EVIDENCE_ROUTE, REQUEST_ID_HEADER, sandboxAnswerSchema, sandboxContract } from "@intentic/sandbox-contract";
import { createORPCClient, type InferClientInputs, type InferClientOutputs, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink, type OpenAPILinkOptions } from "@orpc/openapi-client/fetch";
import { trackPerf } from "../../../app/perf";
import { uuid } from "../../../lib/uuid";
import { driftedRouteReason, routeAdvertised, staleDaemonReason } from "../overview/useDaemonRoutes";
import { sandboxAuthenticatedFetch, SandboxUnaddressedError } from "./sandboxAuthFetch";
import { refusalText, SandboxHttpError, wordsOf } from "./sandboxHttpError";
import { currentSandboxTarget, type SandboxTarget, targetFor } from "./sandboxTarget";

// The typed oRPC client for the sandbox daemons, the one way the app calls a contract procedure. A call's context
// aims and paces it; a refusal reads as a SandboxHttpError in the daemon's words, and an answer arrives parsed by the
// procedure's output schema. The raw sandboxClient remains for what the contract does not carry: bytes and uploads.

// How one call reaches its daemon, beside its input.
export interface SandboxCallContext {
    // Another sandbox by id; absent means the active one. Only the active daemon's refusals get a route-drift reading:
    // this browser's fingerprint of its own daemon says nothing about another box's build.
    readonly at?: string | undefined;
    // Nobody is waiting (a fleet-wide poll): never raises a sign-in, and with no credential in hand fails the way an
    // unreachable box does.
    readonly background?: boolean;
    // `false` lifts the headers deadline for an answer that takes as long as the work it asks for (a land).
    readonly deadline?: false;
}

export type SandboxRpc = ContractRouterClient<typeof sandboxContract, SandboxCallContext>;

// A procedure by its route name (`git.log`), the name the daemon advertises and drift messages speak.
export type ProcedureName = { [G in keyof SandboxRpc & string]: `${G}.${keyof SandboxRpc[G] & string}` }[keyof SandboxRpc & string];
type ProcedureNamed<N extends ProcedureName> = N extends `${infer G extends keyof SandboxRpc}.${infer P}`
    ? P extends keyof SandboxRpc[G]
        ? SandboxRpc[G][P]
        : never
    : never;
export type ProcedureInput<N extends ProcedureName> = InferClientInputs<ProcedureNamed<N>>;
export type ProcedureOutput<N extends ProcedureName> = InferClientOutputs<ProcedureNamed<N>>;

// The daemon a call is aimed at, resolved per request so a sandbox switch or a relocated daemon applies to the very
// next call.
const targetOf = (context: SandboxCallContext): SandboxTarget => {
    const target = context.at === undefined ? currentSandboxTarget() : targetFor(context.at);
    if (target === undefined) {
        throw new SandboxUnaddressedError();
    }
    return target;
};

// The body a refusal came with: a hand-written route's, arriving undecoded under `data.body`, or an oRPC handler's error,
// whose one word for the reader is its message.
const refusalBody = (error: ORPCError<string, unknown>): unknown => {
    const data = error.data as { readonly body?: unknown } | undefined;
    return data !== undefined && typeof data === `object` && `body` in data ? data.body : { message: error.message };
};

// What a failed call throws: an HTTP refusal as a SandboxHttpError, in the daemon's own words unless the active daemon
// lacks the route or shapes it differently; anything that never got an answer (a dead tunnel, an abort) as it was.
const refusalOf = (error: unknown, route: string | undefined): unknown => {
    if (!(error instanceof ORPCError)) {
        return error;
    }
    const said = wordsOf(refusalBody(error));
    const drift =
        route === undefined ? undefined : error.status === 404 ? staleDaemonReason(route) : error.status === 400 ? driftedRouteReason(route) : undefined;
    return new SandboxHttpError(error.status, drift ?? refusalText(error.status, said), said);
};

// Reaching the daemon, independent of caller: base, credentials, clock; shared by both clients below.
const linkOptions: OpenAPILinkOptions<SandboxCallContext> = {
    url: ({ context }) => targetOf(context).base,
    // Resolved per request, not captured at construction, so a fetch replaced later (a test stub, instrumentation)
    // still applies. Timed on the same rpc.request span as the raw client, session renewal included.
    fetch: (request, _init, { context }) => {
        // Correlates this call with the daemon's own http.request line, sent only once the active daemon advertises
        // support: unconditionally, it forces a CORS preflight that fails the whole request on an older daemon.
        const requestId = context.at === undefined && routeAdvertised(REQUEST_ID_EVIDENCE_ROUTE) === true ? uuid() : undefined;
        const headers = new Headers(request.headers);
        if (requestId !== undefined) {
            headers.set(REQUEST_ID_HEADER, requestId);
        }
        return trackPerf(`rpc.request`, { path: new URL(request.url).pathname, method: request.method, requestId }, () =>
            sandboxAuthenticatedFetch(new Request(request, { headers }), targetOf(context), {
                deadline: context.deadline !== false,
                background: context.background === true,
            }),
        );
    },
};

// Every answer as the app reads it, for its own client and each extension's alike: a refusal becomes a
// SandboxHttpError in the daemon's words, and what arrived is parsed by the procedure's output schema.
const answered: NonNullable<OpenAPILinkOptions<SandboxCallContext>[`interceptors`]>[number] = async ({ path, context, next }) => {
    const answer = await next().catch((error: unknown) => {
        throw refusalOf(error, context.at === undefined ? path.join(`.`) : undefined);
    });
    const schema = sandboxAnswerSchema(path);
    return schema === undefined ? answer : schema.parse(answer);
};

// The app's own client, ungated, since the app is the host itself.
export const sandboxRpc: SandboxRpc = createORPCClient(new OpenAPILink(sandboxContract, { ...linkOptions, interceptors: [answered] }));

// One client per extension, gated at the procedure rather than the request: the gate sees the named procedure
// and input directly, and throws to refuse before anything is sent.
export const gatedSandboxRpc = (gate: (procedure: readonly string[], input: unknown) => void): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(
        new OpenAPILink(sandboxContract, {
            ...linkOptions,
            interceptors: [
                ({ path, input, next }) => {
                    gate(path, input);
                    return next();
                },
                answered,
            ],
        }),
    );

// The HTTP status behind a failed call, or undefined when it never got an answer (DNS, TLS, a dead tunnel, an
// abort). A streamed answer's own failure arrives mid-stream as an ORPCError, past the refusal translation above.
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
// routes answer `{ error }`.
export const daemonErrorMessage = (error: unknown): string =>
    error instanceof ORPCError ? refusalText(error.status, wordsOf(refusalBody(error))) : errorMessage(error);

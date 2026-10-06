import { noteEdgeVerdict } from "./edgeVerdict";
import { type SandboxBearer, useSandboxSession } from "../session/sandboxSession";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";
import { useEndpoint } from "../endpoint/useEndpoint";
import { useSandbox } from "./useSandbox";

const { getSessionToken, rejectSessionToken } = useSandboxSession();
const { usingLocal, demoteIfUnreachable, routeRechecked, onRouteLost } = useEndpoint();
const { activeSandboxId } = useSandbox();

export class SandboxUnaddressedError extends Error {
    constructor() {
        super(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
}

// 401 is a bearer the daemon no longer takes; 428 is one it takes but that the sandbox's passkey rule holds short.
// Both drop the bearer and re-establish once: the second road runs through the step-up gate.
const bearerRefused = (status: number): boolean => status === 401 || status === 428;

// Bounds waiting for response headers only; a stream answers its headers immediately then runs indefinitely.
// Exported because a span that reached it is a stall rather than slowness, which is what the connecting gate names.
export const DEADLINE_MS = 45_000;

export class SandboxTimeoutError extends Error {
    constructor() {
        super(`Your sandbox didn't answer in time.`);
    }
}

// True for bodies that stream from disk; those can't be given a headers deadline, since headers arrive only
// after the whole body has been sent.
export const uploadsBody = (body: BodyInit | null | undefined): boolean =>
    body instanceof Blob || body instanceof FormData || body instanceof ReadableStream || body instanceof ArrayBuffer || ArrayBuffer.isView(body);

// The caller's own signal plus the deadline, so an abort still aborts and neither hides the other.
const bounded = (request: Request, deadline: AbortSignal | undefined): AbortSignal =>
    deadline === undefined ? request.signal : AbortSignal.any([request.signal, deadline]);

// fetch keeps its signal on the body too, so the deadline reaches it only through this switch, released once headers arrive.
const headersDeadline = (expiry: AbortSignal | undefined): { readonly signal: AbortSignal | undefined; readonly release: () => void } => {
    if (expiry === undefined) {
        return { signal: undefined, release: () => undefined };
    }
    const due = new AbortController();
    const trip = (): void => due.abort(expiry.reason);
    expiry.addEventListener(`abort`, trip, { once: true });
    return { signal: due.signal, release: () => expiry.removeEventListener(`abort`, trip) };
};

const belongsTo = (request: Request, target: SandboxTarget): boolean =>
    request.url === target.base || request.url.startsWith(`${target.base.replace(/\/$/, ``)}/`);

// The same call aimed at another address of the same sandbox: path, method, headers and body kept.
const rebased = async (request: Request, from: string, to: string): Promise<Request> => {
    const path = request.url.slice(from.replace(/\/$/, ``).length);
    const body = request.method === `GET` || request.method === `HEAD` ? undefined : await request.arrayBuffer();
    return new Request(`${to.replace(/\/$/, ``)}${path}`, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
        cache: request.cache,
        credentials: request.credentials,
        redirect: request.redirect,
    });
};

// After a sleep the loopback address is re-checked before calls queue on it (useEndpoint.ts): a call aimed at it waits
// for the verdict, then goes where the sandbox's base points now, the tunnel when the loopback was found dead.
const afterRecheck = async (request: Request, target: SandboxTarget): Promise<{ readonly request: Request; readonly target: SandboxTarget }> => {
    const recheck = target.sandboxId === undefined ? undefined : routeRechecked(target.sandboxId);
    if (recheck === undefined) {
        return { request, target };
    }
    await recheck;
    const now = currentSandboxTarget();
    if (now === undefined || now.sandboxId !== target.sandboxId || now.base === target.base) {
        return { request, target };
    }
    return { request: await rebased(request, target.base, now.base), target: now };
};

// Calls still waiting for headers, per address: a loopback address found dead while the tunnel answers drops them at
// once as timed out, so each caller's retry goes to the tunnel instead of sitting out the deadline first.
const waiting = new Map<string, Set<AbortController>>();
const dropWaiting = (base: string): void => {
    for (const call of waiting.get(base) ?? []) {
        call.abort();
    }
};
// Heard from the first call on, not at import, so a module that only imports this one registers nothing.
let hearingLoss = false;

const waitOn = (base: string) => {
    if (!hearingLoss) {
        hearingLoss = true;
        onRouteLost(dropWaiting);
    }
    const call = new AbortController();
    const calls = waiting.get(base) ?? new Set<AbortController>();
    calls.add(call);
    waiting.set(base, calls);
    return {
        signal: call.signal,
        release: () => {
            calls.delete(call);
            if (calls.size === 0 && waiting.get(base) === calls) {
                waiting.delete(base);
            }
        },
    };
};

const authenticated = (request: Request, target: SandboxTarget, token: string): Request => {
    const headers = new Headers(request.headers);
    headers.set(`authorization`, `Bearer ${token}`);
    if (target.connectToken !== undefined) {
        headers.set(`x-intentic-connect`, target.connectToken);
    } else {
        headers.delete(`x-intentic-connect`);
    }
    return new Request(request, { headers });
};

// On the loopback shortcut, a missed deadline asks whether the tunnel does better before demoting, since the usual
// cause is a busy daemon; on the tunnel there's nowhere better to go.
const timedOut = (): SandboxTimeoutError => {
    const id = activeSandboxId.value;
    if (usingLocal.value && id !== undefined) {
        void demoteIfUnreachable(id);
    }
    return new SandboxTimeoutError();
};

// The credential this call will present, or why it has none. A press with no credential is someone to prompt; a
// background poll is a box to draw as silent.
const bearerFor = async (target: SandboxTarget, background: boolean): Promise<SandboxBearer> => {
    const bearer = await getSessionToken(target, { background });
    if (bearer === undefined) {
        throw new Error(background ? `This browser holds no session for that sandbox yet.` : `Sign in with Google to reach your sandbox.`);
    }
    return bearer;
};

// Retries once on 401 or 428, invalidating exactly the bearer that failed, against the same target. `deadline` bounds
// only the wait for headers (off for streamed uploads); `background` skips any sign-in prompt.
export const sandboxAuthenticatedFetch = async (
    given: Request,
    givenTarget = currentSandboxTarget(),
    options?: { readonly deadline?: boolean; readonly background?: boolean },
): Promise<Response> => {
    if (givenTarget === undefined) {
        throw new SandboxUnaddressedError();
    }
    if (!belongsTo(given, givenTarget)) {
        throw new DOMException(`The selected sandbox changed while this request was signing in.`, `AbortError`);
    }
    // A streamed upload is never held or re-aimed: its body cannot be read twice.
    const bounds = options?.deadline !== false;
    const { request, target } = bounds ? await afterRecheck(given, givenTarget) : { request: given, target: givenTarget };
    const background = options?.background === true;
    const bearer = await bearerFor(target, background);
    const expiry = bounds ? AbortSignal.timeout(DEADLINE_MS) : undefined;
    const deadline = headersDeadline(expiry);
    const lost = bounds ? waitOn(target.base) : undefined;
    const signal = lost === undefined ? bounded(request, deadline.signal) : AbortSignal.any([bounded(request, deadline.signal), lost.signal]);
    // Cloned before the first fetch consumes the body, so the retry has its own independent copy.
    const retrySource = request.clone();
    const send = async (outgoing: Request, token: string): Promise<Response> => {
        try {
            const answer = await globalThis.fetch(new Request(authenticated(outgoing, target, token), { signal }));
            // The one place every daemon call passes through, and the only place the edge's own verdict is still a
            // response rather than an oRPC error. Noted here so the connection machine can read it.
            noteEdgeVerdict(target.sandboxId, answer);
            return answer;
        } catch (error: unknown) {
            // Only our own deadline, or the address being found dead, is translated to a timeout; the caller's abort keeps
            // its original identity.
            if (request.signal.aborted === true) {
                throw error;
            }
            if (expiry?.aborted === true) {
                throw timedOut();
            }
            throw lost?.signal.aborted === true ? new SandboxTimeoutError() : error;
        }
    };
    // One deadline for the call, retry included; released on the way out, once the answer's headers are in.
    try {
        const response = await send(request, bearer.token);
        if (!bearerRefused(response.status)) {
            return response;
        }

        // Blames the bearer this request actually sent, not whatever is on file by the time the response lands.
        rejectSessionToken(target, bearer);
        const replacement = await getSessionToken(target, { background });
        if (replacement === undefined) {
            return response;
        }
        await response.body?.cancel().catch(() => undefined);
        return await send(retrySource, replacement.token);
    } finally {
        deadline.release();
        lost?.release();
    }
};

import { noteEdgeVerdict } from "./edgeVerdict";
import { type SandboxBearer, useSandboxSession } from "../session/sandboxSession";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";
import { useEndpoint } from "../secrets/useEndpoint";
import { useSandbox } from "./useSandbox";

const { getSessionToken, rejectSessionToken } = useSandboxSession();
const { usingLocal, demoteIfUnreachable } = useEndpoint();
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
    request: Request,
    target = currentSandboxTarget(),
    options?: { readonly deadline?: boolean; readonly background?: boolean },
): Promise<Response> => {
    if (target === undefined) {
        throw new SandboxUnaddressedError();
    }
    if (!belongsTo(request, target)) {
        throw new DOMException(`The selected sandbox changed while this request was signing in.`, `AbortError`);
    }
    const background = options?.background === true;
    const bearer = await bearerFor(target, background);
    const expiry = options?.deadline === false ? undefined : AbortSignal.timeout(DEADLINE_MS);
    const deadline = headersDeadline(expiry);
    const signal = bounded(request, deadline.signal);
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
            // Only our own deadline is translated to a timeout; the caller's abort keeps its original identity.
            throw expiry?.aborted === true && request.signal.aborted !== true ? timedOut() : error;
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
    }
};

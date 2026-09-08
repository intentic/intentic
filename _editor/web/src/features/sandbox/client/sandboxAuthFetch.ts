import { type SandboxBearer, useSandboxSession } from "./sandboxSession";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";
import { useEndpoint } from "../secrets/useEndpoint";
import { useSandbox } from "./useSandbox";

const { getSessionToken, rejectSessionToken } = useSandboxSession();
const { usingLocal, demote } = useEndpoint();
const { activeSandboxId } = useSandbox();

export class SandboxUnaddressedError extends Error {
    constructor() {
        super(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
}

// Bounds waiting for response headers only; a stream answers its headers immediately then runs indefinitely.
const DEADLINE_MS = 45_000;

export class SandboxTimeoutError extends Error {
    constructor() {
        super(`Your sandbox didn't answer in time. Retrying on a different connection.`);
    }
}

// True for bodies that stream from disk; those can't be given a headers deadline, since headers arrive only
// after the whole body has been sent.
export const uploadsBody = (body: BodyInit | null | undefined): boolean =>
    body instanceof Blob || body instanceof FormData || body instanceof ReadableStream || body instanceof ArrayBuffer || ArrayBuffer.isView(body);

// The caller's own signal plus the deadline, so an abort still aborts and neither hides the other.
const bounded = (request: Request, deadline: AbortSignal | undefined): AbortSignal =>
    deadline === undefined ? request.signal : AbortSignal.any([request.signal, deadline]);

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

// On the loopback shortcut, a timeout demotes the endpoint since the tunnel next door can still reach the daemon;
// on the tunnel there's nowhere better to go.
const timedOut = (): SandboxTimeoutError => {
    const id = activeSandboxId.value;
    if (usingLocal.value && id !== undefined) {
        demote(id);
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

// Retries once on 401, invalidating exactly the bearer that failed, against the same target. `deadline` bounds
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
    const signal = bounded(request, expiry);
    // Cloned before the first fetch consumes the body, so the retry has its own independent copy.
    const retrySource = request.clone();
    const send = async (outgoing: Request, token: string): Promise<Response> => {
        try {
            return await globalThis.fetch(new Request(authenticated(outgoing, target, token), { signal }));
        } catch (error: unknown) {
            // Only our own deadline is translated to a timeout; the caller's abort keeps its original identity.
            throw expiry?.aborted === true && request.signal.aborted !== true ? timedOut() : error;
        }
    };
    const response = await send(request, bearer.token);
    if (response.status !== 401) {
        return response;
    }

    // Blames the bearer this request actually sent, not whatever is on file by the time the response lands.
    rejectSessionToken(target, bearer);
    const replacement = await getSessionToken(target, { background });
    if (replacement === undefined) {
        return response;
    }
    await response.body?.cancel().catch(() => undefined);
    return send(retrySource, replacement.token);
};

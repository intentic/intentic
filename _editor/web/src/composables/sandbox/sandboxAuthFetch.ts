import { type SandboxBearer, useSandboxSession } from "./sandboxSession";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";
import { useEndpoint } from "./useEndpoint";
import { useSandbox } from "./useSandbox";

const { getSessionToken, rejectSessionToken } = useSandboxSession();
const { usingLocal, demote } = useEndpoint();
const { activeSandboxId } = useSandbox();

export class SandboxUnaddressedError extends Error {
    constructor() {
        super(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
}

/* HOW LONG A DAEMON CALL MAY GO WITHOUT ANSWERING ITS HEADERS BEFORE IT IS TREATED AS BROKEN.
 *
 * `fetch` has no timeout, so until this existed a request that never got a connection waited for the life of
 * the tab. That is not hypothetical: with the loopback shortcut on plain HTTP/1.1 and its six connections per
 * origin spent on streams, requests measurably sat in the browser's queue for 221 seconds, against a daemon
 * answering everything else in a mean of 66ms. Nothing anywhere said so, no error, no log, no state, only a
 * workspace that had stopped painting.
 *
 * HEADERS, not the whole response, which is what makes one number fit every call. A stream (`/events`, an
 * attach, a deploy's progress) answers its headers immediately and then runs for as long as it likes; an
 * ordinary read is finished by then. So this bounds "did the daemon get to us at all", which is the only thing
 * that goes catastrophically wrong, and never how long the answer may take.
 *
 * Generously above what a real sandbox needs: the daemon's own slow-request log tops out around 8s with the
 * machine under load. Anything approaching this is a request that has not been sent yet. */
const DEADLINE_MS = 45_000;

export class SandboxTimeoutError extends Error {
    constructor() {
        super(`Your sandbox didn't answer in time. Retrying on a different connection.`);
    }
}

/* Bodies this must NOT bound, and the reason the choice is the CALLER's rather than something inferred here.
 *
 * A request's headers arrive only after its body has been sent, so a deadline on headers is a deadline on the
 * upload for anything that streams from disk: a bundle restore is multiple gigabytes, and legitimately takes
 * longer than any figure that would still be useful for a read. By the time a Request exists its body is a
 * ReadableStream whatever it started as, so this cannot be told from in here, which is why it is passed. */
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

/* A request that ran out of time. Whether that is worth changing course over depends on WHERE it was sent: on
 * the loopback shortcut it means this browser is asking that transport for more than its six connections can
 * carry, and the tunnel next door multiplexes, so the window moves (the same demotion the reconnect policy
 * uses, expiring on its own backoff). On the tunnel there is nowhere better to go and the error is the whole
 * answer. Either way the caller sees a failure it can retry, which is the point: a request that fails is one
 * TanStack Query will re-issue, and the one that hung was invisible to everything. */
const timedOut = (): SandboxTimeoutError => {
    const id = activeSandboxId.value;
    if (usingLocal.value && id !== undefined) {
        demote(id);
    }
    return new SandboxTimeoutError();
};

/* THE CREDENTIAL THIS CALL WILL PRESENT, or the reason there is none, which are different sentences for the two
 * kinds of caller. A press that cannot be authenticated is a person to talk to; a poll that cannot be is a box
 * to draw as silent, and telling it to sign in would be an instruction about a machine it is not looking at. */
const bearerFor = async (target: SandboxTarget, background: boolean): Promise<SandboxBearer> => {
    const bearer = await getSessionToken(target, { background });
    if (bearer === undefined) {
        throw new Error(background ? `This browser holds no session for that sandbox yet.` : `Sign in with Google to reach your sandbox.`);
    }
    return bearer;
};

/* The one browser→daemon fetch policy, shared by raw and typed clients. A 401 proves middleware rejected the
 * request before its handler ran, so replaying it once is safe even for POST: invalidate exactly the rejected
 * bearer, establish against the SAME snapshotted target, and retry. No second retry means a real permission or
 * identity problem escapes instead of becoming a reconnect loop.
 *
 * `deadline` bounds the wait for HEADERS and defaults to on: the callers that must switch it off are the few
 * that stream a body up (see uploadsBody), and defaulting the other way is how the hang got to be unbounded in
 * the first place. One deadline covers the retry too, deliberately, it is the CALL's budget, not the attempt's.
 *
 * `background` says NOBODY IS WAITING ON THIS ONE, which is the whole of what the credential layer needs to
 * know to keep Google off the screen (sandboxSession's header states the rule). It travels with the request
 * rather than being inferred from the target, because "is the user waiting" is a fact about the CALLER: the
 * same box, on the same address, is polled by a ledger nobody is looking at and opened by a press, and only one
 * of those may interrupt. A background call that has no credential in hand fails instead, which the ambient
 * stores already read as "this box is not answering". */
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
    // Clone before the first fetch consumes a body. The retry owns an independent branch of the same bytes.
    const retrySource = request.clone();
    const send = async (outgoing: Request, token: string): Promise<Response> => {
        try {
            return await globalThis.fetch(new Request(authenticated(outgoing, target, token), { signal }));
        } catch (error: unknown) {
            // Only OUR deadline is translated. A caller's own abort keeps its identity, or every cancelled
            // read would demote the endpoint and report a sandbox that was never asked anything.
            throw expiry?.aborted === true && request.signal.aborted !== true ? timedOut() : error;
        }
    };
    const response = await send(request, bearer.token);
    if (response.status !== 401) {
        return response;
    }

    // The refusal is attributed to the credential this request actually spent, not to whatever is on file by
    // the time the answer lands: see SandboxBearer for what re-reading it cost.
    rejectSessionToken(target, bearer);
    const replacement = await getSessionToken(target, { background });
    if (replacement === undefined) {
        return response;
    }
    await response.body?.cancel().catch(() => undefined);
    return send(retrySource, replacement.token);
};

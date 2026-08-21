import { useSandboxSession } from "./sandboxSession";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";

const { getSessionToken, rejectSessionToken } = useSandboxSession();

export class SandboxUnaddressedError extends Error {
    constructor() {
        super(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
}

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

/* The one browser→daemon fetch policy, shared by raw and typed clients. A 401 proves middleware rejected the
 * request before its handler ran, so replaying it once is safe even for POST: invalidate exactly the rejected
 * bearer, establish against the SAME snapshotted target, and retry. No second retry means a real permission or
 * identity problem escapes instead of becoming a reconnect loop. */
export const sandboxAuthenticatedFetch = async (request: Request, target = currentSandboxTarget()): Promise<Response> => {
    if (target === undefined) {
        throw new SandboxUnaddressedError();
    }
    if (!belongsTo(request, target)) {
        throw new DOMException(`The selected sandbox changed while this request was signing in.`, `AbortError`);
    }
    const token = await getSessionToken(target);
    if (token === undefined) {
        throw new Error(`Sign in with Google to reach your sandbox.`);
    }
    // Clone before the first fetch consumes a body. The retry owns an independent branch of the same bytes.
    const retrySource = request.clone();
    const response = await globalThis.fetch(authenticated(request, target, token));
    if (response.status !== 401) {
        return response;
    }

    rejectSessionToken(target, token);
    const replacement = await getSessionToken(target);
    if (replacement === undefined) {
        return response;
    }
    await response.body?.cancel().catch(() => undefined);
    return globalThis.fetch(authenticated(retrySource, target, replacement));
};

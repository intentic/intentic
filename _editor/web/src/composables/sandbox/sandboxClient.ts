import { driftedRouteReason, staleDaemonReason } from "./useDaemonRoutes";
import { trackPerf } from "../perf";
import { CHUNK_BYTES } from "../workspace/uploadChunking";
import { sandboxAuthenticatedFetch, uploadsBody } from "./sandboxAuthFetch";
import { useSandboxSession } from "./sandboxSession";
import { currentSandboxTarget } from "./sandboxTarget";

// Calls the ACTIVE sandbox's daemon DIRECTLY (browser → https://sandbox-<id>.<zone>, or its loopback shortcut
// when the sandbox turns out to be on this machine, see useEndpoint), authenticated by a daemon-session
// bearer (no cookies; see sandboxSession), the platform is out of this path. The base comes from the resolved
// endpoint and the connection token from the active sandbox (useSandbox, populated by sandbox.list).
// Returns the raw Response so callers read `.json()` or stream `.body` themselves.

const { getSessionToken, rejectSessionToken } = useSandboxSession();

/* Timed from the caller's first instruction to the response headers, which deliberately INCLUDES
 * `getSessionToken`, because a session renewal round-trip is time the caller waited and every previous account
 * of a slow read left it out. The daemon's own `http.request` line covers the same call from its side, so the
 * two together locate the cost: agree ⇒ the daemon; browser much larger ⇒ the tunnel, the token, or a queue in
 * here. `path` is stripped of its query so a hundred distinct file reads aggregate into one row.
 */
export async function sandboxRequest(path: string, init?: RequestInit): Promise<Response> {
    return trackPerf(`rpc.request`, { path: path.split(`?`)[0] ?? path, method: init?.method ?? `GET` }, async () => {
        const target = currentSandboxTarget();
        if (target === undefined) {
            throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
        }
        /* The headers deadline, minus the calls that send a body up: their headers cannot arrive until the
         * upload finishes, and a bundle restore is gigabytes (BundleCard). Decided here because this is the
         * last place the body is still the thing the caller passed rather than a stream. */
        return sandboxAuthenticatedFetch(new Request(`${target.base}${path}`, init), target, !uploadsBody(init?.body));
    });
}

// A non-2xx daemon response, carrying the HTTP status so callers can branch on it (e.g. a 404 on a file read
// means the file was deleted → close its tab) without matching the daemon's message text.
export class SandboxHttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

// The daemon's user-facing failure, from a non-2xx response body: oRPC handlers put the text on `message`, the
// hand-written daemon routes on `error`; fall back to the status when the body carries neither (or isn't JSON).
//
// Two statuses get an extra check first, for the two ways a browser newer than its daemon fails (see
// useDaemonRoutes).
//
// A 404 is a route this app knows and the daemon never advertised, identical on the wire to "that file isn't
// there", and the single most expensive ambiguity in the product: it reads as a broken feature, and the only
// way to tell used to be rebuilding the image to see if it changed. When the daemon has positively told us it
// lacks the route, say so instead of passing the daemon's generic text through.
//
// A 400 on a route both sides HAVE but shape differently is the same ambiguity one step in: the daemon's own
// validation rejected a field this app sent, and its message describes the field rather than the reason the
// field is unexpected. Only claimed when the fingerprints positively disagree, an ordinary bad request on an
// agreed route keeps the daemon's text, which is the more useful of the two.
export async function sandboxError(response: Response, request?: { method: string; path: string }): Promise<SandboxHttpError> {
    if (request !== undefined) {
        const reason =
            response.status === 404
                ? staleDaemonReason(request.method, request.path)
                : response.status === 400
                  ? driftedRouteReason(request.method, request.path)
                  : undefined;
        if (reason !== undefined) {
            return new SandboxHttpError(response.status, reason);
        }
    }
    const detail = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    return new SandboxHttpError(response.status, detail?.message ?? detail?.error ?? `Request failed (${response.status}).`);
}

// A GET/POST straight to the daemon that parses the JSON body, throwing the daemon's user-facing message on a
// non-2xx (denylist 404, escape 400, oversize 413, …). Shared by the workspace/inventory/state reads.
export async function sandboxJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await sandboxRequest(path, init);
    if (!response.ok) {
        throw await sandboxError(response, { method: init?.method ?? `GET`, path });
    }
    return (await response.json()) as T;
}

// Raw bytes for binary preview (images / PDF), where a utf8 decode would corrupt the file.
export async function sandboxBlob(path: string, init?: RequestInit): Promise<Blob> {
    const response = await sandboxRequest(path, init);
    if (!response.ok) {
        throw await sandboxError(response, { method: init?.method ?? `GET`, path });
    }
    return response.blob();
}

// If an upload makes no progress for this long, treat the request as hung: abort it and fail. Real uploads emit
// `progress` continuously, so idle = stuck. This is the floor that stops one non-settling request (e.g. a daemon
// that never answers under a concurrent delete) from wedging the upload pool forever.
// ponytail: idle-timeout heuristic, raise it if a huge single file legitimately pauses between progress ticks.
const UPLOAD_STALL_MS = 60_000;

// Upload a file body to the daemon via XMLHttpRequest, deliberately NOT fetch. A fetch streaming body
// (ReadableStream + duplex:"half") only works over HTTP/2, so it sends NOTHING when the daemon is reached over
// HTTP/1.1 (the loopback shortcut, or any direct base with no Cloudflare tunnel in front, and the shortcut
// makes that the COMMON case, not the exotic one). A plain File/Blob body still streams from
// disk (never buffered into JS memory) and works on any HTTP version; xhr.upload's progress gives real byte
// feedback. Same auth as sandboxRequest. `onProgress` receives the CUMULATIVE uploaded byte count for this body.
// The promise ALWAYS settles, abort (via opts.signal), stall watchdog, error, and load are all handled, so a
// caller awaiting it can never hang. `opts.signal` aborting rejects with an AbortError.
//
// Cloudflare's edge caps a request body at ~100 MB (a bigger POST is refused mid-send, which the browser can only
// see as a silent stall), so the body goes up as sequential ≤CHUNK_BYTES slices, each its own request carrying
// `&offset=` that the daemon writes in place. slice() stays lazy (still streams from disk), each part gets a
// fresh stall watchdog, and a failed part rejects the whole call, the caller's retry re-sends from part 0,
// which is idempotent because offset writes just overwrite.
export async function sandboxUpload(path: string, body: Blob, opts?: { onProgress?: (loaded: number) => void; signal?: AbortSignal }): Promise<void> {
    const target = currentSandboxTarget();
    if (target === undefined) {
        throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
    const signal = opts?.signal;
    for (let offset = 0; offset === 0 || offset < body.size; offset += CHUNK_BYTES) {
        if (signal?.aborted) {
            throw new DOMException(`Upload canceled`, `AbortError`);
        }
        // Per part, so a token can't expire mid-way through a huge multi-part file (getSessionToken caches/renews).
        let bearer = await getSessionToken(target);
        if (bearer === undefined) {
            throw new Error(`Sign in with Google to reach your sandbox.`);
        }
        const url = `${target.base}${path}&offset=${offset}`;
        const part = body.slice(offset, offset + CHUNK_BYTES);
        try {
            await sendPart(url, part, offset, bearer.token, target.connectToken, opts);
        } catch (error) {
            if (!(error instanceof SandboxHttpError) || error.status !== 401) {
                throw error;
            }
            rejectSessionToken(target, bearer);
            bearer = await getSessionToken(target);
            if (bearer === undefined) {
                throw error;
            }
            await sendPart(url, part, offset, bearer.token, target.connectToken, opts);
        }
    }
}

const sendPart = (
    url: string,
    part: Blob,
    offset: number,
    token: string,
    connectToken: string | undefined,
    opts?: { onProgress?: (loaded: number) => void; signal?: AbortSignal },
): Promise<void> => {
    const signal = opts?.signal;
    return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(`POST`, url);
        xhr.setRequestHeader(`authorization`, `Bearer ${token}`);
        if (connectToken !== undefined) {
            xhr.setRequestHeader(`x-intentic-connect`, connectToken);
        }

        // Idle watchdog: (re)armed on send + every progress tick; fires only when the request goes silent.
        let stall: ReturnType<typeof setTimeout>;
        const arm = (): void => {
            clearTimeout(stall);
            stall = setTimeout(() => {
                reject(new Error(`Upload stalled: no progress for ${UPLOAD_STALL_MS / 1000}s.`));
                xhr.abort();
            }, UPLOAD_STALL_MS);
        };
        const onSignalAbort = (): void => xhr.abort();
        signal?.addEventListener(`abort`, onSignalAbort);
        xhr.addEventListener(`loadend`, () => {
            clearTimeout(stall);
            signal?.removeEventListener(`abort`, onSignalAbort);
        });

        xhr.upload.addEventListener(`progress`, (event) => {
            arm();
            opts?.onProgress?.(offset + event.loaded);
        });
        xhr.addEventListener(`load`, () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
                return;
            }
            const detail = ((): { error?: string } | undefined => {
                try {
                    return JSON.parse(xhr.responseText) as { error?: string };
                } catch {
                    return undefined;
                }
            })();
            reject(new SandboxHttpError(xhr.status, detail?.error ?? `Request failed (${xhr.status}).`));
        });
        xhr.addEventListener(`error`, () => reject(new Error(`Upload failed: the sandbox was unreachable.`)));
        // Aborted either by the caller's signal (cancel) or by the stall watchdog. If the watchdog already rejected
        // with its message, this second reject is ignored (a promise settles once).
        xhr.addEventListener(`abort`, () => reject(new DOMException(`Upload canceled`, `AbortError`)));
        arm();
        xhr.send(part);
    });
};

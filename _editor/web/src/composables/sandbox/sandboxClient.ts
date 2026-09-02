import { driftedRouteReason, staleDaemonReason } from "./useDaemonRoutes";
import { trackPerf } from "../perf";
import { CHUNK_BYTES } from "../workspace/uploadChunking";
import { sandboxAuthenticatedFetch, uploadsBody } from "./sandboxAuthFetch";
import { useSandboxSession } from "./sandboxSession";
import { currentSandboxTarget, type SandboxTarget, targetFor } from "./sandboxTarget";

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
const requestTo = async (target: SandboxTarget | undefined, path: string, init?: RequestInit, background = false): Promise<Response> =>
    trackPerf(`rpc.request`, { path: path.split(`?`)[0] ?? path, method: init?.method ?? `GET` }, async () => {
        if (target === undefined) {
            throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
        }
        /* The headers deadline, minus the calls that send a body up: their headers cannot arrive until the
         * upload finishes, and a bundle arriving is gigabytes (ArrivalCard). Decided here because this is the
         * last place the body is still the thing the caller passed rather than a stream. */
        return sandboxAuthenticatedFetch(new Request(`${target.base}${path}`, init), target, {
            deadline: !uploadsBody(init?.body),
            background,
        });
    });

export async function sandboxRequest(path: string, init?: RequestInit): Promise<Response> {
    return requestTo(currentSandboxTarget(), path, init);
}

/* The same call aimed at a NAMED sandbox rather than the active one. Everything below the address is
 * unchanged: the same auth policy, the same bearer store (keyed by sandbox id already), the same perf row.
 *
 * Deliberately a separate entry point rather than an optional argument on `sandboxRequest`. Almost every call
 * in this app is about the box the user is standing in, and that must stay the thing you get by default. A
 * call that crosses to another sandbox is a decision, so it is spelled differently, which is also what makes
 * the handful of them greppable. */
export async function sandboxRequestAt(sandboxId: string, path: string, init?: RequestInit): Promise<Response> {
    return requestTo(targetFor(sandboxId), path, init);
}

/* THE SAME CALL AIMED BY A REACH: a sandbox id, or `undefined` meaning the active box. The two entry points
 * above stay as they are, because which one a call site names is a decision worth reading; this is for the
 * callers that HOLD the decision as a value and would otherwise each write the same ternary.
 *
 * That is what a conversation homed in another sandbox is (Conversation.box): one object whose whole
 * correspondence, send, attach, steer, stop, transcript, has to go to the same daemon, chosen once when it was
 * created. Nine ternaries agreeing about that is nine chances for one of them not to. */
export async function sandboxRequestVia(at: string | undefined, path: string, init?: RequestInit): Promise<Response> {
    return at === undefined ? sandboxRequest(path, init) : sandboxRequestAt(at, path, init);
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

// What the two reads below share, which is everything except who is waiting for the answer.
const jsonAt = async <T,>(sandboxId: string, path: string, init: RequestInit | undefined, background: boolean): Promise<T> => {
    const response = await requestTo(targetFor(sandboxId), path, init, background);
    if (!response.ok) {
        throw await sandboxError(response);
    }
    return (await response.json()) as T;
};

// The same read aimed at a named sandbox (see sandboxRequestAt). The route-drift checks inside `sandboxError`
// are the active daemon's fingerprint and so are skipped here: another box's build is not one this browser has
// ever handshaked with, and claiming "your sandbox is out of date" from the wrong fingerprint is worse than
// passing the daemon's own words through.
export async function sandboxJsonAt<T>(sandboxId: string, path: string, init?: RequestInit): Promise<T> {
    return jsonAt<T>(sandboxId, path, init, false);
}

/* THE SAME READ MADE BY NOBODY, which is a different kind of call and is spelled like one: the ambient stores
 * that poll every OTHER sandbox the account owns (fleetAcross, changesAcross) and the marks that ride along
 * with them.
 *
 * What a call may SPEND depends on whether a person is waiting for it. A box this browser holds no session for
 * takes the whole establishment path, and its first step is a Google mint: One Tap is browser UI, and the app's
 * own gate behind it covers the entire window. So a poll of a laptop that is switched off asked the reader to
 * sign in to the workspace they were already using — on every refresh, about a machine they were not looking
 * at, with nothing on the gate able to say which machine it was about. Quiet calls take the credential already
 * in hand and, when there is none, fail: the stores above read that exactly as they read a dead tunnel, which
 * is the honest answer for a box this browser cannot currently reach.
 *
 * Spelled apart from `sandboxJsonAt` for the reason that one is spelled apart from `sandboxJson`: it is a
 * decision, it belongs where the call is written, and the few that make it should be findable. */
export async function sandboxJsonQuietly<T>(sandboxId: string, path: string, init?: RequestInit): Promise<T> {
    return jsonAt<T>(sandboxId, path, init, true);
}

// The reach-aimed read, on `sandboxRequestVia`'s terms: `undefined` is the active box. For the callers holding
// a reach as a value (agentActions' mutations, a conversation's own box).
export async function sandboxJsonVia<T>(at: string | undefined, path: string, init?: RequestInit): Promise<T> {
    return at === undefined ? sandboxJson<T>(path, init) : sandboxJsonAt<T>(at, path, init);
}

// Raw bytes for binary preview (images / PDF), where a utf8 decode would corrupt the file. `at` names the
// sandbox when the bytes are not in the active one, which is what lets a review of an agent in another box
// render its screenshots rather than fetching the active daemon's answer for a path it has never heard of.
export async function sandboxBlob(path: string, init?: RequestInit, at?: string): Promise<Blob> {
    const response = at === undefined ? await sandboxRequest(path, init) : await sandboxRequestAt(at, path, init);
    if (!response.ok) {
        throw await sandboxError(response, at === undefined ? { method: init?.method ?? `GET`, path } : undefined);
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
// `opts.at` names the sandbox when the bytes do not belong in the active one, the same trailing reach
// `sandboxBlob` takes: a file dropped on a conversation homed in another box has to land on THAT box's disk,
// since the path this returns is the one the prompt will tell that daemon to read.
// Resolved once, before the first part goes up, so a multi-part upload cannot pair one box's bearer with
// another's address halfway through (SandboxTarget is a snapshot for exactly this reason).
const uploadTarget = (at: string | undefined): SandboxTarget => {
    const target = at === undefined ? currentSandboxTarget() : targetFor(at);
    if (target === undefined) {
        throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
    return target;
};

export async function sandboxUpload(
    path: string,
    body: Blob,
    opts?: { onProgress?: (loaded: number) => void; signal?: AbortSignal; at?: string },
): Promise<void> {
    const target = uploadTarget(opts?.at);
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

import { driftedRouteReason, staleDaemonReason } from "../overview/useDaemonRoutes";
import { trackPerf } from "../../../app/perf";
import { CHUNK_BYTES } from "../../workspace/files/uploadChunking";
import { sandboxAuthenticatedFetch, uploadsBody } from "./sandboxAuthFetch";
import { useSandboxSession } from "./sandboxSession";
import { currentSandboxTarget, type SandboxTarget, targetFor } from "./sandboxTarget";

// Calls the active sandbox's daemon directly (or its loopback shortcut), authenticated by a daemon-session
// bearer; no cookies, no platform in this path. Base comes from the resolved endpoint, connect token from the
// active sandbox. Returns the raw Response; callers read `.json()` or stream `.body` themselves.

const { getSessionToken, rejectSessionToken } = useSandboxSession();

// Includes any session renewal in its timing, so browser and daemon timings can be compared to locate slowness.
// `path` drops its query so per-file reads aggregate into one row.
const requestTo = async (target: SandboxTarget | undefined, path: string, init?: RequestInit, background = false): Promise<Response> =>
    trackPerf(`rpc.request`, { path: path.split(`?`)[0] ?? path, method: init?.method ?? `GET` }, async () => {
        if (target === undefined) {
            throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
        }
        // Exempt from the headers deadline when the body streams up; its headers arrive only once the upload finishes.
        return sandboxAuthenticatedFetch(new Request(`${target.base}${path}`, init), target, {
            deadline: !uploadsBody(init?.body),
            background,
        });
    });

export async function sandboxRequest(path: string, init?: RequestInit): Promise<Response> {
    return requestTo(currentSandboxTarget(), path, init);
}

// The same call aimed at a named sandbox instead of the active one; same auth, same bearer store, same perf row.
// Its own entry point, not an optional argument, so crossing sandboxes stays a visible, greppable decision.
export async function sandboxRequestAt(sandboxId: string, path: string, init?: RequestInit): Promise<Response> {
    return requestTo(targetFor(sandboxId), path, init);
}

// Aims the same call by a reach value (a sandbox id, or undefined for the active box), for callers holding the
// decision as data instead of writing the ternary themselves.
export async function sandboxRequestVia(at: string | undefined, path: string, init?: RequestInit): Promise<Response> {
    return at === undefined ? sandboxRequest(path, init) : sandboxRequestAt(at, path, init);
}

// A non-2xx daemon response, carrying the HTTP status so callers can branch on it without matching message text.
export class SandboxHttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

// Reads the daemon's message (`message`/`error`, or the status as fallback) unless drift evidence says
// otherwise: a 404 on an unadvertised route, or a 400 with a disagreed shape, get a drift message instead.
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

// A GET/POST to the daemon that parses the JSON body and throws the daemon's message on any non-2xx status.
export async function sandboxJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await sandboxRequest(path, init);
    if (!response.ok) {
        throw await sandboxError(response, { method: init?.method ?? `GET`, path });
    }
    return (await response.json()) as T;
}

// What sandboxJsonAt and sandboxJsonQuietly share; only whether anyone is waiting on the answer differs.
const jsonAt = async <T,>(sandboxId: string, path: string, init: RequestInit | undefined, background: boolean): Promise<T> => {
    const response = await requestTo(targetFor(sandboxId), path, init, background);
    if (!response.ok) {
        throw await sandboxError(response);
    }
    return (await response.json()) as T;
};

// The same read aimed at a named sandbox. Route-drift checks are skipped: this browser's own daemon fingerprint
// says nothing about another box's build.
export async function sandboxJsonAt<T>(sandboxId: string, path: string, init?: RequestInit): Promise<T> {
    return jsonAt<T>(sandboxId, path, init, false);
}

// For polls where nobody is waiting (fleet-wide stores), so no sign-in prompt is ever triggered. Uses whatever
// credential is already in hand, and fails, read the same as an unreachable box, when there is none.
export async function sandboxJsonQuietly<T>(sandboxId: string, path: string, init?: RequestInit): Promise<T> {
    return jsonAt<T>(sandboxId, path, init, true);
}

// The reach-aimed read; undefined means the active box. For callers holding a reach as a value instead of
// writing the ternary.
export async function sandboxJsonVia<T>(at: string | undefined, path: string, init?: RequestInit): Promise<T> {
    return at === undefined ? sandboxJson<T>(path, init) : sandboxJsonAt<T>(at, path, init);
}

// Raw bytes for binary preview (images/PDF), where a utf8 decode would corrupt the file. `at` names the sandbox
// when the bytes live elsewhere.
export async function sandboxBlob(path: string, init?: RequestInit, at?: string): Promise<Blob> {
    const response = at === undefined ? await sandboxRequest(path, init) : await sandboxRequestAt(at, path, init);
    if (!response.ok) {
        throw await sandboxError(response, at === undefined ? { method: init?.method ?? `GET`, path } : undefined);
    }
    return response.blob();
}

// Aborts an upload with no progress this long, as stuck; raise it for legitimately slow multi-GB files.
const UPLOAD_STALL_MS = 60_000;

// XMLHttpRequest, not fetch: a streaming body needs HTTP/2, which the loopback shortcut lacks. Chunked into
// ≤CHUNK_BYTES parts via `&offset=`, idempotent so a retry resumes from part 0.
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
        // Refreshed per part, so a token can't expire partway through a large multi-part upload.
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

        // Idle watchdog, rearmed on send and every progress tick; fires only once the request goes silent.
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
        // Fires from the caller's abort or the stall watchdog; only the first reject on a promise ever counts.
        xhr.addEventListener(`abort`, () => reject(new DOMException(`Upload canceled`, `AbortError`)));
        arm();
        xhr.send(part);
    });
};

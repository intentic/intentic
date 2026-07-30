import { useSandboxSession } from "./sandboxSession";
import { staleDaemonReason } from "./useDaemonRoutes";
import { useEndpoint } from "./useEndpoint";
import { useSandbox } from "./useSandbox";
import { CHUNK_BYTES } from "../workspace/uploadChunking";

// Calls the ACTIVE sandbox's daemon DIRECTLY (browser → https://sandbox-<id>.<zone>, or its loopback shortcut
// when the sandbox turns out to be on this machine — see useEndpoint), authenticated by a daemon-session
// bearer (no cookies; see sandboxSession) — the platform is out of this path. The base comes from the resolved
// endpoint and the connection token from the active sandbox (useSandbox, populated by sandbox.list).
// Returns the raw Response so callers read `.json()` or stream `.body` themselves.

const { active } = useSandbox();
const { daemonBase } = useEndpoint();
const { getSessionToken } = useSandboxSession();

export async function sandboxRequest(path: string, init?: RequestInit): Promise<Response> {
    const base = daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(`Your sandbox isn't reachable yet — finish setup so it registers its address.`);
    }
    const token = await getSessionToken();
    if (token === undefined) {
        throw new Error(`Sign in with Google to reach your sandbox.`);
    }
    const headers = new Headers(init?.headers);
    headers.set(`authorization`, `Bearer ${token}`);
    // The daemon binds its owner on the FIRST authenticated request (TOFU), but only if it carries the sandbox's
    // connection token as `x-intentic-connect`. We send the active sandbox's token on every call (the daemon
    // ignores it once the owner is bound; members' tokens are harmless post-bind).
    const connectToken = active.value?.token;
    if (connectToken !== undefined) {
        headers.set(`x-intentic-connect`, connectToken);
    }
    return fetch(`${base}${path}`, { ...init, headers });
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
// A 404 gets one extra check first. The browser is often newer than the daemon (see useDaemonRoutes), so a
// route this app knows and the daemon never advertised answers 404 — identical on the wire to "that file isn't
// there", and the single most expensive ambiguity in the product: it reads as a broken feature, and the only
// way to tell used to be rebuilding the image to see if it changed. When the daemon has positively told us it
// lacks the route, say so instead of passing the daemon's generic text through.
export async function sandboxError(response: Response, request?: { method: string; path: string }): Promise<SandboxHttpError> {
    if (response.status === 404 && request !== undefined) {
        const reason = staleDaemonReason(request.method, request.path);
        if (reason !== undefined) {
            return new SandboxHttpError(404, reason);
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
// ponytail: idle-timeout heuristic — raise it if a huge single file legitimately pauses between progress ticks.
const UPLOAD_STALL_MS = 60_000;

// Upload a file body to the daemon via XMLHttpRequest — deliberately NOT fetch. A fetch streaming body
// (ReadableStream + duplex:"half") only works over HTTP/2, so it sends NOTHING when the daemon is reached over
// HTTP/1.1 (the loopback shortcut, or any direct base with no Cloudflare tunnel in front — and the shortcut
// makes that the COMMON case, not the exotic one). A plain File/Blob body still streams from
// disk (never buffered into JS memory) and works on any HTTP version; xhr.upload's progress gives real byte
// feedback. Same auth as sandboxRequest. `onProgress` receives the CUMULATIVE uploaded byte count for this body.
// The promise ALWAYS settles — abort (via opts.signal), stall watchdog, error, and load are all handled — so a
// caller awaiting it can never hang. `opts.signal` aborting rejects with an AbortError.
//
// Cloudflare's edge caps a request body at ~100 MB (a bigger POST is refused mid-send, which the browser can only
// see as a silent stall), so the body goes up as sequential ≤CHUNK_BYTES slices, each its own request carrying
// `&offset=` that the daemon writes in place. slice() stays lazy (still streams from disk), each part gets a
// fresh stall watchdog, and a failed part rejects the whole call — the caller's retry re-sends from part 0,
// which is idempotent because offset writes just overwrite.
export async function sandboxUpload(path: string, body: Blob, opts?: { onProgress?: (loaded: number) => void; signal?: AbortSignal }): Promise<void> {
    const base = daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(`Your sandbox isn't reachable yet — finish setup so it registers its address.`);
    }
    const connectToken = active.value?.token;
    const signal = opts?.signal;
    for (let offset = 0; offset === 0 || offset < body.size; offset += CHUNK_BYTES) {
        if (signal?.aborted) {
            throw new DOMException(`Upload canceled`, `AbortError`);
        }
        // Per part, so a token can't expire mid-way through a huge multi-part file (getSessionToken caches/renews).
        const token = await getSessionToken();
        if (token === undefined) {
            throw new Error(`Sign in with Google to reach your sandbox.`);
        }
        await sendPart(`${base}${path}&offset=${offset}`, body.slice(offset, offset + CHUNK_BYTES), offset, token, connectToken, opts);
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
                reject(new Error(`Upload stalled — no progress for ${UPLOAD_STALL_MS / 1000}s.`));
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
            reject(new Error(detail?.error ?? `Request failed (${xhr.status}).`));
        });
        xhr.addEventListener(`error`, () => reject(new Error(`Upload failed — the sandbox was unreachable.`)));
        // Aborted either by the caller's signal (cancel) or by the stall watchdog. If the watchdog already rejected
        // with its message, this second reject is ignored (a promise settles once).
        xhr.addEventListener(`abort`, () => reject(new DOMException(`Upload canceled`, `AbortError`)));
        arm();
        xhr.send(part);
    });
};

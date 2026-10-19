import { parseJsonOr } from "@intentic/base/json";
import type { output, ZodType } from "zod";
import { t } from "@intentic/ui/i18n";
import { driftedRouteReason, staleDaemonReason } from "./useDaemonRoutes";
import { trackPerf } from "../../app/perf/perf";
import { CHUNK_BYTES } from "../../lib/files/uploadChunking";
import { sandboxAuthenticatedFetch, uploadsBody } from "./sandboxAuthFetch";
import { loadContract } from "./daemon/contract";
import { refusalText, SandboxHttpError, wordsOf } from "./sandboxHttpError";
import { useSandboxSession } from "../session/sandboxSession";
import { currentSandboxTarget, type SandboxTarget, targetFor } from "./sandboxTarget";
import { encodedPart, type SentPart } from "../../lib/files/uploadEncoding";

// The raw client, for what the contract does not carry: bytes (a file, a thumbnail, a bundle), chunked uploads, the
// daemon's hand-written routes, and extensions' api.sandbox.request/json. Every contract procedure goes through
// sandboxRpc. Authenticated by a daemon-session bearer, no cookies, no platform in this path.

const { getSessionToken, rejectSessionToken } = useSandboxSession();

// Includes any session renewal in its timing, so browser and daemon timings can be compared to locate slowness.
// `path` drops its query so per-file reads aggregate into one row.
const requestTo = async (target: SandboxTarget | undefined, path: string, init?: RequestInit): Promise<Response> =>
    trackPerf(`rpc.request`, { path: path.split(`?`)[0] ?? path, method: init?.method ?? `GET` }, async () => {
        if (target === undefined) {
            throw new Error(t(`sandbox.sandboxClient.unaddressed`));
        }
        // Exempt from the headers deadline when the body streams up: its headers arrive only once the upload finishes.
        return sandboxAuthenticatedFetch(new Request(`${target.base}${path}`, init), target, { deadline: !uploadsBody(init?.body) });
    });

export async function sandboxRequest(path: string, init?: RequestInit): Promise<Response> {
    return requestTo(currentSandboxTarget(), path, init);
}

// Reads the daemon's message (`message`/`error`, or the status as fallback) unless drift evidence says
// otherwise: a 404 on an unadvertised contract route, or a 400 on one with a disagreed shape, gets a drift message.
// Still read here because an extension reaches contract routes through api.sandbox.json.
export async function sandboxError(response: Response, request?: { method: string; path: string }): Promise<SandboxHttpError> {
    const route = request === undefined ? undefined : (await loadContract()).sandboxRouteName(request.method, request.path);
    if (route !== undefined) {
        const reason = response.status === 404 ? staleDaemonReason(route) : response.status === 400 ? driftedRouteReason(route) : undefined;
        if (reason !== undefined) {
            return new SandboxHttpError(response.status, reason);
        }
    }
    const said = wordsOf(await response.json().catch(() => undefined));
    return new SandboxHttpError(response.status, refusalText(response.status, said), said);
}

// A GET/POST to the daemon that parses the JSON body and throws the daemon's message on any non-2xx status.
export async function sandboxJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await sandboxRequest(path, init);
    if (!response.ok) {
        throw await sandboxError(response, { method: init?.method ?? `GET`, path });
    }
    return (await response.json()) as T;
}

// The same, on another of the reader's sandboxes by id, under the reader's own session there: what pairing two of their
// sandboxes reads and writes on the far one. A refusal there says the far daemon's words, never a drift reading of this one.
// Read with the route's own answer schema, the one boundary this answer crosses.
export async function sandboxJsonAt<Answer extends ZodType>(sandboxId: string, path: string, answer: Answer, init?: RequestInit): Promise<output<Answer>> {
    const response = await requestTo(targetFor(sandboxId), path, init);
    if (!response.ok) {
        throw await sandboxError(response);
    }
    return answer.parse(await response.json());
}

// Raw bytes for binary preview (images/PDF), where a utf8 decode would corrupt the file. `at` names the sandbox when
// the bytes live elsewhere; a route-drift reading speaks only for the active one.
export async function sandboxBlob(path: string, init?: RequestInit, at?: string): Promise<Blob> {
    const response = await requestTo(at === undefined ? currentSandboxTarget() : targetFor(at), path, init);
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
        throw new Error(t(`sandbox.sandboxClient.unaddressed`));
    }
    return target;
};

// `whole` sends the body as one request with no `&offset=`, for a route that takes its body in one piece (an archive,
// which the caller already keeps to about one part's size). `encoding` sends each part gzipped, with `&offset=` and
// progress still counted in the body's own bytes; only for a daemon that advertises the coding.
export async function sandboxUpload(
    path: string,
    body: Blob,
    opts?: { onProgress?: (loaded: number) => void; signal?: AbortSignal; at?: string; whole?: boolean; encoding?: `gzip` | undefined },
): Promise<void> {
    const target = uploadTarget(opts?.at);
    const signal = opts?.signal;
    const partBytes = opts?.whole === true ? Math.max(body.size, 1) : CHUNK_BYTES;
    for (let offset = 0; offset === 0 || offset < body.size; offset += partBytes) {
        if (signal?.aborted) {
            throw new DOMException(`Upload canceled`, `AbortError`);
        }
        // Refreshed per part, so a token can't expire partway through a large multi-part upload.
        let bearer = await getSessionToken(target);
        if (bearer === undefined) {
            throw new Error(t(`sandbox.sandboxClient.signIn`));
        }
        const url = opts?.whole === true ? `${target.base}${path}` : `${target.base}${path}&offset=${offset}`;
        const { part, sent } = await encodedPart(body, offset, partBytes, opts?.encoding);
        try {
            await sendPart(url, part, sent, bearer.token, target.connectToken, opts);
        } catch (error) {
            if (!(error instanceof SandboxHttpError) || error.status !== 401) {
                throw error;
            }
            rejectSessionToken(target, bearer);
            bearer = await getSessionToken(target);
            if (bearer === undefined) {
                throw error;
            }
            await sendPart(url, part, sent, bearer.token, target.connectToken, opts);
        }
    }
}

const sendPart = (
    url: string,
    part: Blob,
    sent: SentPart,
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
        if (sent.encoding !== undefined) {
            xhr.setRequestHeader(`content-encoding`, sent.encoding);
        }

        // Idle watchdog, rearmed on send and every progress tick; fires only once the request goes silent.
        let stall: ReturnType<typeof setTimeout>;
        const arm = (): void => {
            clearTimeout(stall);
            stall = setTimeout(() => {
                reject(new Error(t(`sandbox.sandboxClient.uploadStalled`, { seconds: UPLOAD_STALL_MS / 1000 })));
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
            opts?.onProgress?.(sent.offset + Math.round(event.loaded * sent.scale));
        });
        xhr.addEventListener(`load`, () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
                return;
            }
            const detail = parseJsonOr(xhr.responseText, undefined) as { error?: string } | null | undefined;
            reject(new SandboxHttpError(xhr.status, detail?.error ?? t(`sandbox.sandboxClient.requestFailed`, { status: xhr.status })));
        });
        xhr.addEventListener(`error`, () => reject(new Error(t(`sandbox.sandboxClient.uploadUnreachable`))));
        // Fires from the caller's abort or the stall watchdog; only the first reject on a promise ever counts.
        xhr.addEventListener(`abort`, () => reject(new DOMException(`Upload canceled`, `AbortError`)));
        arm();
        xhr.send(part);
    });
};

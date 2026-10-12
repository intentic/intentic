import { type IncomingHttpHeaders, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// One request over node:http(s), for the callers that need what fetch cannot give them per request: skipping
// certificate verification for one host (a self-signed dev platform, a probe the owner marked insecure) without turning
// it off process-wide. Three copies of this lived in local-tls.ts, platform-client.ts and capabilities/probe.ts, and
// each had lost something the others kept: one never heard a response error, so a body cut off mid-read hung its
// caller; two decoded each chunk on its own, splitting a multi-byte character across chunks into replacement
// characters; one left its abort listener on the caller's signal for good. Everything they need is here once.

export interface NodeRequestOptions {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string | Uint8Array | undefined;
    // Accept any certificate. Each caller decides for which hosts; this module only does what it is told.
    readonly insecure?: boolean;
    // Cut a socket that has gone quiet this long, rejecting with `idleError()`; `signal` bounds the whole exchange.
    readonly idleMs?: number;
    readonly idleError?: () => Error;
    readonly signal?: AbortSignal | undefined;
    // Keep at most this many body bytes. Past it the response is destroyed rather than read on, and the answer says so.
    readonly maxBytes?: number;
}

export interface NodeAnswer {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly body: Buffer<ArrayBuffer>;
    // More than `maxBytes` arrived: `body` is its first `maxBytes` bytes and the rest was never read.
    readonly truncated: boolean;
}

// The signal's own reason, as fetch rejects with it, so a caller's timeout reads as a TimeoutError here too.
const abortReason = (signal: AbortSignal | undefined): Error => (signal?.reason instanceof Error ? signal.reason : new Error("aborted"));

// Resolves with whatever the server answered, any status; rejects when it could not be reached, the exchange was cut
// off, went quiet, or was aborted.
export const nodeRequest = (url: URL, options: NodeRequestOptions = {}): Promise<NodeAnswer> => {
    const { signal } = options;
    if (signal?.aborted === true) {
        // Nothing is sent for a caller that has already given up.
        return Promise.reject(abortReason(signal));
    }
    return new Promise<NodeAnswer>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
            req.destroy(abortReason(signal));
        };
        // The caller's signal can outlive this request by far (a daemon-long one), so its listener goes when it settles.
        const settle = (finish: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            finish();
        };
        const fail = (error: Error): void => settle(() => reject(error));
        const send = url.protocol === "http:" ? httpRequest : httpsRequest;
        const req = send(url, { method: options.method ?? "GET", headers: { ...options.headers }, rejectUnauthorized: options.insecure !== true }, (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            const answer = (truncated: boolean): NodeAnswer => ({
                status: response.statusCode ?? 0,
                headers: response.headers,
                // Joined before decoding, so a character split across two chunks arrives whole.
                body: Buffer.concat(chunks, size),
                truncated,
            });
            response.on("data", (chunk: Buffer) => {
                if (settled) {
                    return;
                }
                const max = options.maxBytes;
                if (max !== undefined && size + chunk.byteLength > max) {
                    const kept = chunk.subarray(0, max - size);
                    chunks.push(kept);
                    size += kept.byteLength;
                    settle(() => resolve(answer(true)));
                    // Stop the transfer rather than buffer what will be thrown away.
                    response.destroy();
                    return;
                }
                chunks.push(chunk);
                size += chunk.byteLength;
            });
            // A body cut off mid-read errors the response, not the request; unheard, it would be an uncaught error.
            response.on("error", fail);
            response.on("end", () => settle(() => resolve(answer(false))));
            // A response closed without ending or erroring would otherwise leave the caller waiting for good.
            response.on("close", () => fail(new Error("the response was cut off before it ended")));
        });
        req.on("error", fail);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (options.idleMs !== undefined) {
            const idleMs = options.idleMs;
            const idleError = options.idleError ?? (() => new Error(`no answer for ${idleMs} ms`));
            req.setTimeout(idleMs, () => req.destroy(idleError()));
        }
        req.end(options.body);
    });
};

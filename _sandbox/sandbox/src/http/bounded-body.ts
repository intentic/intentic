// A request body read with a ceiling on the bytes that actually arrive, for every route that sets one. Checking the
// declared Content-Length alone is not a ceiling: a chunked request declares none, and `c.req.json()` then reads
// whatever is sent into memory before any size check runs. Here the declared length refuses early, and the stream is
// counted as it is read and cancelled the moment it passes the limit.

export type BoundedBody<T> =
    | { readonly kind: "ok"; readonly value: T }
    // More than the limit was declared or sent; nothing past the limit was kept.
    | { readonly kind: "tooLarge" }
    // The bytes arrived within the limit but are not what the route reads (not UTF-8 text, not JSON).
    | { readonly kind: "invalid" };

const TOO_LARGE = { kind: "tooLarge" } as const;
const INVALID = { kind: "invalid" } as const;

const declaredTooLarge = (request: Request, max: number): boolean => {
    const declared = Number(request.headers.get("content-length"));
    return Number.isFinite(declared) && declared > max;
};

// The body's bytes, or undefined once more than `max` arrived. An absent body reads as empty.
const readBytes = async (request: Request, max: number): Promise<Uint8Array | undefined> => {
    if (request.body === null) {
        return new Uint8Array();
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        // one stream, read in order
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.byteLength;
        if (size > max) {
            // allow(silent-catch): the sender is refused either way; a cancel that fails has nothing left to stop.
            await reader.cancel().catch(() => undefined);
            return undefined;
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
};

/** The body's raw bytes, at most `max` of them. */
export const readBoundedBytes = async (request: Request, max: number): Promise<BoundedBody<Uint8Array>> => {
    if (declaredTooLarge(request, max)) {
        return TOO_LARGE;
    }
    const bytes = await readBytes(request, max);
    return bytes === undefined ? TOO_LARGE : { kind: "ok", value: bytes };
};

/** The body as UTF-8 text, at most `max` bytes of it; bytes that are not UTF-8 are `invalid`. */
export const readBoundedText = async (request: Request, max: number): Promise<BoundedBody<string>> => {
    const read = await readBoundedBytes(request, max);
    if (read.kind !== "ok") {
        return read;
    }
    try {
        return { kind: "ok", value: new TextDecoder("utf-8", { fatal: true }).decode(read.value) };
    } catch {
        return INVALID;
    }
};

/** The body parsed as JSON, at most `max` bytes of it; anything that does not parse is `invalid`. */
export const readBoundedJson = async (request: Request, max: number): Promise<BoundedBody<unknown>> => {
    const read = await readBoundedText(request, max);
    if (read.kind !== "ok") {
        return read;
    }
    try {
        const value: unknown = JSON.parse(read.value);
        return { kind: "ok", value };
    } catch {
        return INVALID;
    }
};

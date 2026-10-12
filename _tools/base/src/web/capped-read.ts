// A fetched response's body read with a ceiling on the bytes that actually arrive. Checking the declared
// Content-Length and then calling `text()` or `arrayBuffer()` is not a ceiling: a chunked answer declares none, and the
// whole body is in memory before the size is looked at. Here the stream is counted as it is read and cancelled the
// moment it passes the cap, so nothing past it is downloaded, let alone kept. Web Response only, so it runs wherever
// fetch does.
//
// Only a body with MORE than `maxBytes` is truncated: one that arrives at exactly the cap is whole. (webq's copy
// flagged that one too; the daemon's did not, and a page of exactly the cap is not cut.)

export interface CappedBody {
    // At most `maxBytes` bytes: the whole body, or its first `maxBytes` when it was longer.
    readonly bytes: Uint8Array;
    // More than `maxBytes` arrived, or the time ran out, and reading stopped there.
    readonly truncated: boolean;
}

export interface CappedText {
    readonly text: string;
    readonly truncated: boolean;
}

export interface CappedReadOptions {
    // Stop reading this long after the read began and keep what arrived, marked truncated. Checked between chunks, so a
    // caller that must not wait on one slow chunk bounds the fetch with an AbortSignal too, which ends the stream.
    readonly timeoutMs?: number;
}

const join = (chunks: readonly Uint8Array[], size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
};

/** The response's body, reading no further than one chunk past `maxBytes`. An absent body reads as empty. */
export const readCappedBytes = async (response: Response, maxBytes: number, options: CappedReadOptions = {}): Promise<CappedBody> => {
    if (response.body === null) {
        return { bytes: new Uint8Array(), truncated: false };
    }
    const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const stop = async (bytes: Uint8Array): Promise<CappedBody> => {
        // allow(silent-catch): the rest is refused either way; a cancel that fails has nothing left to stop.
        await reader.cancel().catch(() => undefined);
        return { bytes, truncated: true };
    };
    for (;;) {
        if (Date.now() > deadline) {
            return await stop(join(chunks, size));
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one stream, read in order
        const { done, value } = await reader.read();
        if (done) {
            return { bytes: join(chunks, size), truncated: false };
        }
        if (size + value.byteLength > maxBytes) {
            chunks.push(value.subarray(0, maxBytes - size));
            return await stop(join(chunks, maxBytes));
        }
        chunks.push(value);
        size += value.byteLength;
    }
};

/** The body as UTF-8 text (malformed bytes replaced, as `Response.text()` does), at most `maxBytes` bytes of it. */
export const readCappedText = async (response: Response, maxBytes: number, options: CappedReadOptions = {}): Promise<CappedText> => {
    const { bytes, truncated } = await readCappedBytes(response, maxBytes, options);
    return { text: new TextDecoder().decode(bytes), truncated };
};

import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { jsonLinesOf } from "./json-lines.js";

// The global ReadableStream (bun-types' in a test program) and node:stream/web's name one runtime object that the
// checker sees no overlap between; a stream crossing that line is renamed here and nowhere else.
export const nodeStream = <T>(stream: ReadableStream<T>): NodeReadableStream<T> => stream as unknown as NodeReadableStream<T>;

export const webStream = <T>(stream: NodeReadableStream<T>): ReadableStream<T> => stream as unknown as ReadableStream<T>;

// A web stream as an async iterable read through its own reader: not every runtime makes a ReadableStream iterable,
// and a consumer that stops early releases the stream rather than leaving it locked.
export async function* chunksOf<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
    const reader = stream.getReader();
    try {
        for (;;) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one stream, read in order
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            yield value;
        }
    } finally {
        // allow(silent-catch): a stream that already ended or errored has nothing left to cancel
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

// A web stream's newline-delimited JSON records, by the rules of `json-lines.ts` (UTF-8 across chunks, LF only, \r
// dropped, a final unterminated record kept).
export const webJsonLines = (stream: ReadableStream<Uint8Array | string>): AsyncGenerator<string> => jsonLinesOf(chunksOf(stream));

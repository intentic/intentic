import type { Readable } from "node:stream";

// The one reader of a newline-delimited JSON stream (a child's stdio protocol, a bridge's answers), hardened where the
// copies it replaces each broke:
// - Decoded across chunk boundaries: a character split between two chunks, decoded one chunk at a time, is two
//   replacement characters in the record.
// - Split at LF only. Node's readline also breaks lines at U+2028 and U+2029, which JSON allows raw inside a string and
//   which Codex and Pi do not escape, so a record holding one reached JSON.parse as two halves.
// - A trailing \r is dropped (a Windows peer's CRLF), blank lines are skipped, and a last record the stream ended
//   without its LF is still a record.
// It yields the lines, not parsed values: a bad line is the caller's to skip or report, and one JSON.parse that throws
// must never end the stream for every line after it.

const record = (line: string): string | undefined => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    return text.trim() === "" ? undefined : text;
};

// Any source of text or bytes in order: a Node Readable, a web ReadableStream that is async-iterable, or chunks in a test.
export async function* jsonLinesOf(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
    // TextDecoder in streaming mode keeps a partial character for the next chunk, as StringDecoder does, and runs where
    // there is no Node.
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of chunks) {
        buffer += chunk instanceof Uint8Array ? decoder.decode(chunk, { stream: true }) : chunk;
        let start = 0;
        for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n", start)) {
            const line = record(buffer.slice(start, newline));
            start = newline + 1;
            if (line !== undefined) {
                yield line;
            }
        }
        // Sliced once per chunk rather than once per line, so a chunk of many short records is not copied once each.
        buffer = buffer.slice(start);
    }
    const last = record(buffer + decoder.decode());
    if (last !== undefined) {
        yield last;
    }
}

// A Node stream's records, one per LF; the stream is left as it was (no encoding is set on it).
export const jsonLines = (stream: Readable): AsyncGenerator<string> =>
    // SAFETY: a Readable yields Buffers (Uint8Arrays), or strings once someone set an encoding on it; nothing else.
    jsonLinesOf(stream as AsyncIterable<Uint8Array | string>);

// Each record parsed, a line that is not JSON handed to `onBadLine` (when given) and skipped, so one torn or chatty line
// costs that line and nothing after it.
export async function* parsedJsonLines(chunks: AsyncIterable<Uint8Array | string>, onBadLine?: (line: string) => void): AsyncGenerator<unknown> {
    for await (const line of jsonLinesOf(chunks)) {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            onBadLine?.(line);
            continue;
        }
        yield value;
    }
}

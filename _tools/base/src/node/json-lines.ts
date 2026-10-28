import type { Readable } from "node:stream";

// Reads JSON lines with decoding across chunk boundaries and splits only at LF: U+2028/U+2029 are valid inside JSON strings.
// Drops trailing CR and blank lines, and yields a final record even without LF.
// Yields unparsed lines so callers can handle a malformed record without losing the rest of the stream.

const record = (line: string): string | undefined => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    return text.trim() === "" ? undefined : text;
};

// Any source of text or bytes in order: a Node Readable, a web ReadableStream that is async-iterable, or chunks in a test.
export async function* jsonLinesOf(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
    // TextDecoder in streaming mode keeps a partial character for the next chunk, as StringDecoder does, and runs where
    // there is no Node.
    const decoder = new TextDecoder();
    // Keep unfinished records in fragments: appending to a growing buffer and searching it again on every chunk
    // repeatedly copies and scans the same prefix, making large fragmented records quadratic.
    const fragments: string[] = [];
    for await (const chunk of chunks) {
        const text = chunk instanceof Uint8Array ? decoder.decode(chunk, { stream: true }) : chunk;
        let start = 0;
        for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
            let lineText = text.slice(start, newline);
            if (fragments.length > 0) {
                fragments.push(lineText);
                lineText = fragments.join("");
                fragments.length = 0;
            }
            const line = record(lineText);
            start = newline + 1;
            if (line !== undefined) {
                yield line;
            }
        }
        if (start < text.length) {
            fragments.push(text.slice(start));
        }
    }
    const last = record(fragments.join("") + decoder.decode());
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

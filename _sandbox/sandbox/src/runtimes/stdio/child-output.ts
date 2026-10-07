import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// What every runtime reads off the process it started: its JSONL protocol on stdout, and the tail of what it said on the
// way down. Both decode across chunk boundaries, since a character split between two chunks decoded one chunk at a time
// is two replacement characters in the record or the error.

// The stream's records, one per LF. Node's readline also breaks lines at U+2028 and U+2029, which JSON allows raw inside
// a string and which Codex and Pi do not escape, so a record holding one reached JSON.parse as two halves. A trailing
// \r is dropped, blank lines are skipped, and a last record the stream ended without its LF is still a record.
export async function* jsonLines(stream: Readable): AsyncGenerator<string> {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== "") {
                yield line.endsWith("\r") ? line.slice(0, -1) : line;
            }
        }
    }
    const last = buffer + decoder.end();
    if (last.trim() !== "") {
        yield last.endsWith("\r") ? last.slice(0, -1) : last;
    }
}

export interface OutputTail {
    // Keeps what the stream says, with a decoder of its own, so two streams kept in one tail do not split each other's
    // characters. The stream itself is left as it was: no encoding is set on it.
    readonly follow: (stream: Readable | null | undefined) => void;
    // Text the process did not say itself, such as the spawn error of a command that is not on PATH.
    readonly append: (text: string) => void;
    readonly text: () => string;
}

// The last `chars` characters a process said, for the error that reports its exit.
export const outputTail = (chars: number): OutputTail => {
    let tail = "";
    const append = (text: string): void => {
        tail = (tail + text).slice(-chars);
        // A cut through a surrogate pair leaves its low half first, which prints as a replacement character.
        const first = tail.charCodeAt(0);
        if (first >= 0xdc00 && first <= 0xdfff) {
            tail = tail.slice(1);
        }
    };
    return {
        follow: (stream) => {
            const decoder = new StringDecoder("utf8");
            stream?.on("data", (chunk: Buffer | string) => append(typeof chunk === "string" ? chunk : decoder.write(chunk)));
        },
        append,
        text: () => tail,
    };
};

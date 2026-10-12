import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// What every runtime reads off the process it started: its JSONL protocol on stdout, and the tail of what it said on the
// way down. Both decode across chunk boundaries, since a character split between two chunks decoded one chunk at a time
// is two replacement characters in the record or the error.

// The stream's records, one per LF (never at U+2028/U+2029, which Codex and Pi leave raw inside strings): the one reader
// lives in base, beside the other protocols that read the same framing.
export { jsonLines } from "@intentic/base/json-lines";

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

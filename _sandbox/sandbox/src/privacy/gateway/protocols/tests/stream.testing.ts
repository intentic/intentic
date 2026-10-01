import { isRecord, isText, type Json, type JsonObject, parseJson } from "../walk.js";

// Runs an SSE fixture through a restoring transform the way a socket would deliver it: whole, cut at every byte
// offset, and one byte at a time. A restorer only ever sees whole events, so every delivery must produce the very
// same bytes; that one equality covers tokens, UTF-8 characters, `\r\n` pairs and events split across chunks.

const encoder = new TextEncoder();

export const run = async (transform: TransformStream<Uint8Array, Uint8Array>, chunks: readonly Uint8Array[]): Promise<string> => {
    const source = new ReadableStream<Uint8Array>({
        start: (controller) => {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });
    return new Response(source.pipeThrough(transform)).text();
};

export const runText = async (transform: TransformStream<Uint8Array, Uint8Array>, text: string): Promise<string> =>
    run(transform, [encoder.encode(text)]);

// The output for the whole fixture, after checking every two-chunk split and the byte-at-a-time delivery give the same.
export const runEverySplit = async (makeTransform: () => TransformStream<Uint8Array, Uint8Array>, text: string): Promise<string> => {
    const bytes = encoder.encode(text);
    const whole = await run(makeTransform(), [bytes]);
    const mismatches: number[] = [];
    for (let at = 0; at <= bytes.length; at += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each split is its own stream; running them one by one keeps a failure's offset readable.
        const output = await run(makeTransform(), [bytes.slice(0, at), bytes.slice(at)]);
        if (output !== whole) {
            mismatches.push(at);
        }
    }
    expect(mismatches).toEqual([]);
    const byteAtATime = await run(
        makeTransform(),
        Array.from(bytes, (_, at) => bytes.slice(at, at + 1)),
    );
    expect(byteAtATime).toBe(whole);
    return whole;
};

export interface WireEvent {
    readonly event: string | undefined;
    readonly data: string | undefined;
}

// A deliberately naive reader of the output, independent of the one under test.
export const parseWire = (text: string): readonly WireEvent[] =>
    text
        .replaceAll("\r\n", "\n")
        .split("\n\n")
        .filter((block) => block.trim() !== "")
        .map((block) => {
            const lines = block.split("\n");
            const event = lines
                .find((line) => line.startsWith("event:"))
                ?.slice("event:".length)
                .trim();
            const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).replace(/^ /u, ""));
            return { event, data: data.length === 0 ? undefined : data.join("\n") };
        });

// The data of every JSON event, parsed; `[DONE]` and comments are left out.
export const payloads = (text: string): readonly JsonObject[] =>
    parseWire(text).flatMap(({ data }) => {
        const payload = data === undefined ? undefined : parseJson(data);
        return isRecord(payload) ? [payload] : [];
    });

// An SSE body from `[event, payload]` pairs, the way Anthropic and the Responses API frame them. A string payload is
// sent as written (`[DONE]`, a body that is not JSON).
export const sse = (events: readonly (readonly [string | undefined, Json])[], newline = "\n"): string =>
    events
        .map(([event, payload]) => {
            const data = isText(payload) ? payload : JSON.stringify(payload);
            return `${event === undefined ? "" : `event: ${event}${newline}`}data: ${data}${newline}${newline}`;
        })
        .join("");

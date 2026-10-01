import { jsonEvent, type SseEvent, sseTransform } from "../sse.js";
import { parseWire, run, runEverySplit, runText } from "./stream.testing.js";

// The event reader every restorer stands on. Whatever a restorer leaves alone must reach the client byte for byte,
// however the socket cut the stream.

const identity = (): TransformStream<Uint8Array, Uint8Array> => sseTransform({ onEvent: (event) => [event], onEnd: () => [] });

const recording = (seen: SseEvent[]): TransformStream<Uint8Array, Uint8Array> =>
    sseTransform({
        onEvent: (event) => {
            seen.push(event);
            return [event];
        },
        onEnd: () => [],
    });

describe("the SSE transform", () => {
    test("an untouched stream comes out byte for byte however it is cut", async () => {
        // Mixed framing (`\n`, `\r\n`, a lone `\r`), comments, a multi-line data field, multibyte text and a final event
        // with no blank line after it: all of it must survive every split point.
        const stream = [
            ": keep-alive\n\n",
            'event: ping\r\ndata: {"type": "ping"}\r\n\r\n',
            'event: content_block_delta\ndata: {"text":"Zażółć 🎉 ⟦PERSON_1⟧"}\n\n',
            "data: first line\rdata: second line\r\r",
            'id: 7\nretry: 1000\ndata: {"a":1}\n\n',
            "data: [DONE]\n",
        ].join("");
        expect(await runEverySplit(identity, stream)).toBe(stream);
    });

    test("the handler sees the same events however the bytes are cut", async () => {
        // Byte-identical output alone would not catch a `\r\n` read as two line ends: raw passthrough hides it. The events
        // themselves must not depend on where a chunk ended.
        const stream = 'event: a\r\ndata: {"t":"ż🎉"}\r\n\r\nevent: b\r\ndata: x\r\n\r\n';
        const bytes = new TextEncoder().encode(stream);
        const eventsFor = async (chunks: readonly Uint8Array[]): Promise<string> => {
            const seen: SseEvent[] = [];
            await run(recording(seen), chunks);
            return JSON.stringify(seen.map(({ event, data }) => [event, data]));
        };
        const whole = await eventsFor([bytes]);
        expect(whole).toBe(
            JSON.stringify([
                ["a", '{"t":"ż🎉"}'],
                ["b", "x"],
            ]),
        );
        const splits = await Promise.all(Array.from({ length: bytes.length + 1 }, async (_, at) => eventsFor([bytes.slice(0, at), bytes.slice(at)])));
        expect(splits.filter((events) => events !== whole)).toEqual([]);
    });

    test("events reach the handler whole, with their data lines joined", async () => {
        const seen: SseEvent[] = [];
        await runText(recording(seen), 'event: a\r\ndata: one\r\ndata:two\r\n\r\n: comment\n\ndata: {"x":1}');
        expect(seen.map(({ event, data }) => ({ event, data }))).toEqual([
            { event: "a", data: "one\ntwo" },
            { event: undefined, data: undefined },
            // The stream ended inside this one; it is still delivered rather than dropped.
            { event: undefined, data: '{"x":1}' },
        ]);
    });

    test("a rewritten event is framed as event and data lines", async () => {
        const rewrite = sseTransform({
            onEvent: () => [jsonEvent("message_stop", { type: "message_stop" })],
            onEnd: () => [jsonEvent(undefined, { end: true })],
        });
        const output = await runText(rewrite, "event: x\ndata: {}\n\n");
        expect(output).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\ndata: {"end":true}\n\n');
        expect(parseWire(output)).toEqual([
            { event: "message_stop", data: '{"type":"message_stop"}' },
            { event: undefined, data: '{"end":true}' },
        ]);
    });

    test("a character split across chunks is decoded whole", async () => {
        // The UTF-8 bytes of `ż` and of the emoji land in different chunks; a non-streaming decoder would emit U+FFFD.
        const seen: SseEvent[] = [];
        const bytes = new TextEncoder().encode("data: ż🎉\n\n");
        const source = new ReadableStream<Uint8Array>({
            start: (controller) => {
                for (let at = 0; at < bytes.length; at += 1) {
                    controller.enqueue(bytes.slice(at, at + 1));
                }
                controller.close();
            },
        });
        await new Response(source.pipeThrough(recording(seen))).text();
        expect(seen.map(({ data }) => data)).toEqual(["ż🎉"]);
    });
});

import { parseSseText, type SseEvent, sseData, sseEvents, sseFrames, sseJson } from "./sse.js";

const encoder = new TextEncoder();

// A body that hands over `chunks` in order, then either closes or stays open saying nothing, as a daemon behind a
// wedged tunnel does. `cancelled` records whether the reader let go of it.
const body = (chunks: readonly string[], close: boolean): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } => {
    let cancelled = false;
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            const chunk = chunks[index++];
            if (chunk !== undefined) {
                controller.enqueue(encoder.encode(chunk));
            } else if (close) {
                controller.close();
            }
        },
        cancel() {
            cancelled = true;
        },
    });
    return { stream, cancelled: () => cancelled };
};

const collect = async (frames: AsyncGenerator<string>): Promise<string[]> => {
    const seen: string[] = [];
    for await (const frame of frames) {
        seen.push(frame);
    }
    return seen;
};

it("reassembles frames split across chunks and ends when the stream closes", async () => {
    const { stream } = body([`data: {"a":1}\n`, `\ndata: {"b"`, `:2}\n\n`], true);
    expect(await collect(sseFrames(stream))).toEqual([`data: {"a":1}`, `data: {"b":2}`]);
});

it("ends a stream that goes silent past the idle window, and lets go of it", async () => {
    const { stream, cancelled } = body([`data: {"a":1}\n\n`], false);
    expect(await collect(sseFrames(stream, 20))).toEqual([`data: {"a":1}`]);
    expect(cancelled()).toBe(true);
});

it("reads a frame's data line as JSON, and nothing from a frame without one or with a malformed payload", () => {
    expect(sseData(`event: turn\ndata: {"kind":"end"}`)).toEqual({ kind: `end` });
    expect(sseData(`: keep-alive`)).toBeUndefined();
    expect(sseData(`data: {not json`)).toBeUndefined();
});

const collectEvents = async (events: AsyncGenerator<SseEvent>): Promise<SseEvent[]> => {
    const seen: SseEvent[] = [];
    for await (const event of events) {
        seen.push(event);
    }
    return seen;
};

it("ends events at CRLF, CR and LF blank lines alike, a CRLF split across chunks included", async () => {
    const { stream } = body([`data: 1\r\n\r`, `\ndata: 2\r\rdata: 3\n\n`], true);
    expect((await collectEvents(sseEvents(stream))).map((event) => event.data)).toEqual([`1`, `2`, `3`]);
});

it("joins every data line of an event with a newline", () => {
    expect(parseSseText(`data: {"a":\ndata: 1}\n\n`).map((event) => event.data)).toEqual([`{"a":\n1}`]);
    expect(sseData(`data: {"a":\ndata: 1}`)).toEqual({ a: 1 });
});

it("reads event, id and retry, keeps the last id across events, and skips comments", () => {
    const events = parseSseText(`: hello\nevent: turn\nid: 7\nretry: 3000\ndata: x\n\ndata: y\n\n`);
    expect(events.map(({ event, data, id, retry }) => ({ event, data, id, retry }))).toEqual([
        { event: `turn`, data: `x`, id: `7`, retry: 3000 },
        { event: undefined, data: `y`, id: `7`, retry: undefined },
    ]);
});

it("drops one space after the colon and no more, and a leading byte-order mark", () => {
    expect(parseSseText(`\uFEFFdata:  two spaces\n\n`).map((event) => event.data)).toEqual([` two spaces`]);
});

it("keeps each event's raw text, its blank line included, for a reader forwarding it unchanged", () => {
    expect(parseSseText(`event: a\r\ndata: 1\r\n\r\n: ping\n\n`).map((event) => event.raw)).toEqual([`event: a\r\ndata: 1\r\n\r\n`, `: ping\n\n`]);
});

it("dispatches an event the stream ended inside", async () => {
    const { stream } = body([`data: last`], true);
    expect((await collectEvents(sseEvents(stream))).map((event) => event.data)).toEqual([`last`]);
});

it("ends an event stream that goes silent past the idle window", async () => {
    const { stream, cancelled } = body([`data: 1\n\n`], false);
    expect((await collectEvents(sseEvents(stream, 20))).map((event) => event.data)).toEqual([`1`]);
    expect(cancelled()).toBe(true);
});

it("sseJson reads a parsed event's data", () => {
    expect([sseJson(parseSseText(`data: [1]\n\n`)[0]!), sseJson(parseSseText(`: c\n\n`)[0]!)]).toEqual([[1], undefined]);
});

import { sseData, sseFrames } from "./sse.js";

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

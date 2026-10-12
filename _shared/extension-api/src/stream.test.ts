import { readDaemonStream } from "./stream.js";

const bodyOf = (text: string): ReadableStream<Uint8Array> => new Response(text).body!;

const records = async (text: string): Promise<Record<string, unknown>[]> => {
    const seen: Record<string, unknown>[] = [];
    for await (const record of readDaemonStream(bodyOf(text))) {
        seen.push(record);
    }
    return seen;
};

it("yields each data frame's record, skipping keep-alives and malformed frames", async () => {
    expect(await records(`: ping\n\ndata: {"kind":"step","n":1}\r\n\r\ndata: {broken\n\ndata: {"kind":\ndata: "done"}\n\n`)).toEqual([
        { kind: `step`, n: 1 },
        { kind: `done` },
    ]);
});

it("turns an error event into an error record, its message kept or a default given", async () => {
    expect(await records(`event: error\ndata: {"message":"No room left."}\n\nevent: error\ndata: {}\n\n`)).toEqual([
        { kind: `error`, message: `No room left.` },
        { kind: `error`, message: `Provisioning failed.` },
    ]);
});

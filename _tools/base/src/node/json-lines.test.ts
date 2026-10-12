import { Readable } from "node:stream";
import { jsonLines, jsonLinesOf, parsedJsonLines } from "./json-lines.js";
import { webJsonLines } from "./web-stream.js";

const collect = async (lines: AsyncIterable<unknown>): Promise<unknown[]> => {
    const all: unknown[] = [];
    for await (const line of lines) {
        all.push(line);
    }
    return all;
};

async function* chunks(...parts: readonly (Uint8Array | string)[]): AsyncGenerator<Uint8Array | string> {
    yield* parts;
}

describe("jsonLinesOf", () => {
    // "ł" is two bytes and "😀" four: cut between chunks, a per-chunk decode makes replacement characters of both.
    it("keeps a character whole when a chunk boundary splits its bytes", async () => {
        const bytes = new TextEncoder().encode(`{"a":"zł😀"}\n`);
        const at = bytes.indexOf(0xc5) + 1;
        const emoji = bytes.indexOf(0xf0) + 2;

        const lines = await collect(jsonLinesOf(chunks(bytes.subarray(0, at), bytes.subarray(at, emoji), bytes.subarray(emoji))));

        expect(lines).toEqual([`{"a":"zł😀"}`]);
    });

    it("splits at LF only, never inside a record holding U+2028 or U+2029", async () => {
        const record = `{"text":"one\u2028two\u2029three"}`;

        expect(await collect(jsonLinesOf(chunks(`${record}\n`)))).toEqual([record]);
    });

    it("drops a CRLF's \\r, skips blank lines, and keeps a final record with no LF", async () => {
        expect(await collect(jsonLinesOf(chunks("{\"a\":1}\r\n\r\n  \n{\"b\"", ":2}")))).toEqual(['{"a":1}', '{"b":2}']);
    });

    it("reads a Node stream and a web stream the same way", async () => {
        const text = "{\"a\":1}\n{\"b\":2}";

        expect(await collect(jsonLines(Readable.from([Buffer.from(text)])))).toEqual(['{"a":1}', '{"b":2}']);
        expect(await collect(webJsonLines(new Response(text).body ?? new ReadableStream()))).toEqual(['{"a":1}', '{"b":2}']);
    });
});

describe("parsedJsonLines", () => {
    // One unguarded JSON.parse used to end the whole stream at the first chatty line.
    it("skips a line that is not JSON, reports it, and goes on", async () => {
        const bad: string[] = [];

        const values = await collect(parsedJsonLines(chunks('{"a":1}\nnot json\n{"b":2}\n'), (line) => bad.push(line)));

        expect(values).toEqual([{ a: 1 }, { b: 2 }]);
        expect(bad).toEqual(["not json"]);
    });
});

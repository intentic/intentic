import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
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
    it("decodes bytes from another realm even when they fail instanceof Uint8Array", async () => {
        // DOM consumers replace the global typed-array constructors; Node's response buffers keep their own realm.
        const foreignBytes: (bytes: number[]) => Uint8Array = runInNewContext("(bytes) => new Uint8Array(bytes)");
        const bytes = new TextEncoder().encode('{"text":"é"}\r\n{"last":true}');
        const cut = bytes.indexOf(0xc3) + 1;
        const first = foreignBytes([...bytes.subarray(0, cut)]);
        expect(first instanceof Uint8Array).toBe(false);
        expect(await collect(jsonLinesOf(chunks(first, foreignBytes([...bytes.subarray(cut)]))))).toEqual(['{"text":"é"}', '{"last":true}']);
    });

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

    it("reads a large fragmented record followed by batched records and an unterminated tail", async () => {
        const large = JSON.stringify({ output: "x".repeat(256 * 1024) });
        const text = `${large}\r\n{"next":true}\n{"last":true}`;
        const encoder = new TextEncoder();
        const parts = Array.from({ length: Math.ceil(text.length / 97) }, (_, index) => {
            const part = text.slice(index * 97, (index + 1) * 97);
            return index % 2 === 0 ? encoder.encode(part) : part;
        });

        expect(await collect(jsonLinesOf(chunks(...parts)))).toEqual([large, '{"next":true}', '{"last":true}']);
    });

    it("preserves records at every byte boundary, including CRLF and multibyte characters", async () => {
        const records = ['{"text":"zł😀\u2028\u2029"}', ' {"b":2} ', '{"c":3}'];
        const bytes = new TextEncoder().encode(`${records[0]}\r\n \t\r\n${records[1]}\n${records[2]}`);

        for (let at = 0; at <= bytes.length; at++) {
            const parts = chunks(bytes.subarray(0, at), new Uint8Array(), bytes.subarray(at, at + 1), bytes.subarray(at + 1));
            expect(await collect(jsonLinesOf(parts))).toEqual(records);
        }
    });

    it("flushes incomplete UTF-8 at the end of an unterminated record", async () => {
        expect(await collect(jsonLinesOf(chunks("prefix", new Uint8Array([0xf0]), new Uint8Array([0x9f]))))).toEqual(["prefix\ufffd"]);
    });

    it("skips empty chunks and an unterminated whitespace-only record", async () => {
        expect(await collect(jsonLinesOf(chunks("", new Uint8Array(), "\r", " ", new Uint8Array([0x09]))))).toEqual([]);
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

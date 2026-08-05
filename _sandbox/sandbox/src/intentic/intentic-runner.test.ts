import type { IntenticLine } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { chunksToLines, parseIntenticLine } from "./intentic-runner.js";

const collect = async (lines: AsyncIterable<string>): Promise<string[]> => {
    const out: string[] = [];
    for await (const line of lines) {
        out.push(line);
    }
    return out;
};

async function* chunks(...values: string[]): AsyncGenerator<string> {
    for (const value of values) {
        yield value;
    }
}

test("chunksToLines reassembles lines split across chunk boundaries", async () => {
    expect(await collect(chunksToLines(chunks('{"kind":"no', 'de"}\n{"kind":"iter', 'ation"}\n')))).toEqual([
        '{"kind":"node"}',
        '{"kind":"iteration"}',
    ]);
});

test("chunksToLines flushes a trailing line with no newline", async () => {
    expect(await collect(chunksToLines(chunks('{"kind":"result"}')))).toEqual(['{"kind":"result"}']);
});

test("parseIntenticLine accepts an event object with a string kind", () => {
    expect(parseIntenticLine('{"kind":"node","phase":"apply","id":"host"}')).toEqual({ kind: "node", phase: "apply", id: "host" } as IntenticLine);
});

test("parseIntenticLine ignores blank lines, arrays, and kind-less objects", () => {
    expect(parseIntenticLine("   ")).toBeUndefined();
    expect(parseIntenticLine("[1,2,3]")).toBeUndefined();
    expect(parseIntenticLine('{"phase":"apply"}')).toBeUndefined();
});

test("parseIntenticLine throws on malformed JSON (a contract violation)", () => {
    expect(() => parseIntenticLine("{not json")).toThrow();
});

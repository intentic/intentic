import type { IntenticLine } from "@intentic/sandbox-contract/events/system-events";
import { jsonLinesOf } from "@intentic/base/json-lines";
import { parseIntenticLine } from "./intentic-runner.js";

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

// The runner reads the CLI's stdout through base's jsonLines; these pin what it relies on from it.
test("lines split across chunk boundaries are reassembled", async () => {
    expect(await collect(jsonLinesOf(chunks('{"kind":"no', 'de"}\n{"kind":"iter', 'ation"}\n')))).toEqual([
        '{"kind":"node"}',
        '{"kind":"iteration"}',
    ]);
});

test("a trailing line with no newline is flushed, and a CRLF record parses", async () => {
    const lines = await collect(jsonLinesOf(chunks('{"kind":"node"}\r\n{"kind":"result"}')));
    expect(lines).toEqual(['{"kind":"node"}', '{"kind":"result"}']);
    expect(lines.map(parseIntenticLine)).toEqual([{ kind: "node" }, { kind: "result" }]);
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

import { PassThrough } from "node:stream";
import { jsonLines, outputTail } from "./child-output.js";

const linesOf = async (chunks: readonly (string | Buffer)[]): Promise<string[]> => {
    const stream = new PassThrough();
    const read = (async () => {
        const seen: string[] = [];
        for await (const line of jsonLines(stream)) {
            seen.push(line);
        }
        return seen;
    })();
    for (const chunk of chunks) {
        stream.write(chunk);
    }
    stream.end();
    return read;
};

// The live failure: Codex wrote an agent message holding a raw U+2028, readline broke the record there, JSON.parse threw
// on the first half, and the turn died on a valid line.
test("a record holding a raw line separator inside a string stays one record", async () => {
    const text = "one\u2028two\u2029three";
    const record = JSON.stringify({ method: "item/completed", params: { text } });
    // JSON.stringify leaves both separators raw, as Codex does.
    expect(record).toContain("\u2028");

    const lines = await linesOf([`${record}\n`]);

    expect(lines).toEqual([record]);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ method: "item/completed", params: { text } });
});

test("a character split across two chunks arrives whole, and CRLF, blank lines and an unterminated last record are read", async () => {
    const bytes = Buffer.from(`{"text":"é"}\r\n\n  \n{"id":2}`);
    const cut = bytes.indexOf(0xc3) + 1;

    expect(await linesOf([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual([`{"text":"é"}`, `{"id":2}`]);
});

// Data events arrive on a later tick than the write that caused them.
const flushed = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a tail keeps the last characters of every stream it follows, each decoded across its own chunks", async () => {
    const tail = outputTail(8);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    tail.follow(stdout);
    tail.follow(stderr);
    tail.follow(null);
    const accented = Buffer.from("é");

    stderr.write(accented.subarray(0, 1));
    await flushed();
    stdout.write("ab");
    await flushed();
    stderr.write(accented.subarray(1));
    await flushed();
    tail.append(" gone");

    expect(tail.text()).toBe("abé gone");
    tail.append("!");
    expect(tail.text()).toBe("bé gone!");
});

test("a tail cut through a surrogate pair drops the orphaned half", () => {
    const tail = outputTail(3);
    tail.append("a😀bc");
    expect(tail.text()).toBe("bc");
});

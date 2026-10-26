import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLogReader, logSize } from "./agent-log.js";

let dir: string;
let path: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-log-reader-"));
    path = join(dir, "agent.log");
});
afterEach(async () => await rm(dir, { recursive: true, force: true }));

test("skips history by byte offset and delivers each appended line once", async () => {
    await writeFile(path, "earlier: 日本語\n");
    const lines: string[] = [];
    const reader = agentLogReader(path, await logSize(path), (line) => lines.push(line));
    expect(await reader.read()).toBe(0);
    await appendFile(path, "one\ntwo\n");
    expect(await reader.read()).toBe(Buffer.byteLength("one\ntwo\n"));
    expect(await reader.read()).toBe(0);
    await appendFile(path, "last without newline");
    await reader.read();
    expect(lines).toEqual(["one", "two"]);
    reader.end();
    expect(lines).toEqual(["one", "two", "last without newline"]);
});

test("keeps a UTF-8 character split across writes", async () => {
    const bytes = Buffer.from("日本語\n");
    await writeFile(path, bytes.subarray(0, 2));
    const lines: string[] = [];
    const reader = agentLogReader(path, 0, (line) => lines.push(line));
    await reader.read();
    expect(lines).toEqual([]);
    await appendFile(path, bytes.subarray(2));
    await reader.read();
    reader.end();
    expect(lines).toEqual(["日本語"]);
});

test("assembles lines across read buffers", async () => {
    const line = "x".repeat(70_000);
    await writeFile(path, `${line}\r\nend\n`);
    const lines: string[] = [];
    const reader = agentLogReader(path, 0, (text) => lines.push(text));
    await reader.read();
    reader.end();
    expect(lines).toEqual([line, "end"]);
});

test("drops a previous log's partial line when the file is truncated", async () => {
    await writeFile(path, "old incomplete line");
    const lines: string[] = [];
    const reader = agentLogReader(path, 0, (line) => lines.push(line));
    await reader.read();
    await writeFile(path, "fresh\n");
    await reader.read();
    reader.end();
    expect(lines).toEqual(["fresh"]);
});

test("follows a log created after the first look", async () => {
    const lines: string[] = [];
    const reader = agentLogReader(path, 0, (line) => lines.push(line));
    expect(await logSize(path)).toBe(0);
    await reader.read();
    await writeFile(path, "arrived\n");
    await reader.read();
    reader.end();
    expect(lines).toEqual(["arrived"]);
});

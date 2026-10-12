import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servedOf } from "./subagents.js";

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "served-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

// A reply's text may hold a raw U+2028, which JSON leaves unescaped: split there, the record reached JSON.parse as two
// halves and the child's model read as never recorded.
test("a reply holding a raw line separator still names the model it ran on", async () => {
    const path = join(dir, "agent-a1.jsonl");
    const user = JSON.stringify({ type: "user", message: { content: "ask" } });
    const reply = JSON.stringify({ type: "assistant", effort: "high", message: { model: "claude-test", content: [{ type: "text", text: "one\u2028two" }] } });
    expect(reply).toContain("\u2028");
    await writeFile(path, `${user}\r\n\n${reply}\n`);
    expect(await servedOf(path)).toEqual({ model: "claude-test", effort: "high" });
});

test("a transcript not written yet records nothing", async () => {
    expect(await servedOf(join(dir, "absent.jsonl"))).toBeUndefined();
});

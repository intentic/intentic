import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextBudgetHooks, lastRequestTokens, requestTokensOn } from "./context-cost-notice.js";

// A turn learns what a call now costs the moment its context crosses a line, once per line, and only on its own
// thread: a subagent's context is its own, and a notice that repeats is one that stops being read.

const assistantLine = (read: number, written: number, input = 2, sidechain = false): string =>
    JSON.stringify({
        type: "assistant",
        isSidechain: sidechain,
        message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: written, output_tokens: 10 } },
    });

test("a main-thread request's size is its input plus both cache buckets, and nothing else counts", () => {
    expect(requestTokensOn(assistantLine(300_000, 1_000))).toBe(301_002);
    expect(requestTokensOn(assistantLine(300_000, 1_000, 2, true))).toBeUndefined();
    expect(requestTokensOn(JSON.stringify({ type: "user", message: { content: "hi" } }))).toBeUndefined();
    expect(requestTokensOn(`{"type":"assistant", torn`)).toBeUndefined();
});

test("the latest request is found past a tool result bigger than one read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-budget-"));
    try {
        const path = join(dir, "session.jsonl");
        const bigResult = JSON.stringify({ type: "user", message: { content: "x".repeat(200_000) } });
        writeFileSync(path, [assistantLine(100_000, 0), assistantLine(420_000, 500), bigResult, ""].join("\n"));
        expect(await lastRequestTokens(path)).toBe(420_502);
        expect(await lastRequestTokens(join(dir, "missing.jsonl"))).toBeUndefined();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// SAFETY: the hook reads only these fields of its input (an absent `agent_id` is the main thread), all a test can build.
const call = (agentId?: string) => ({ hook_event_name: "PostToolUse", transcript_path: "/t.jsonl", tool_input: {}, agent_id: agentId }) as never;
const contextOf = (result: unknown): string | undefined =>
    // SAFETY: every answer this hook gives is `{}` or a PostToolUse hookSpecificOutput.
    (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;

test("each line is said once, when it is first crossed, and never to a subagent", async () => {
    const sizes = [120_000, 360_000, 370_000, 380_000, 700_000, 900_000];
    let index = 0;
    const fire = contextBudgetHooks(undefined, async () => sizes[index++]).PostToolUse[0]?.hooks[0];
    if (fire === undefined) {
        throw new Error("expected a PostToolUse hook");
    }
    const said: (string | undefined)[] = [];
    for (let step = 0; step < sizes.length; step++) {
        said.push(contextOf(await fire(call())));
    }
    expect(said.map((text) => text !== undefined)).toEqual([false, true, false, false, true, false]);
    expect(said[1]).toContain("about 360k tokens");
    expect(said[4]).toContain("about 700k tokens");
});

test("a subagent's call reads nothing and is told nothing", async () => {
    let reads = 0;
    const fire = contextBudgetHooks(undefined, async () => {
        reads++;
        return 900_000;
    }).PostToolUse[0]?.hooks[0];
    if (fire === undefined) {
        throw new Error("expected a PostToolUse hook");
    }
    expect(await fire(call("a1b2c3"))).toEqual({});
    expect(reads).toBe(0);
});

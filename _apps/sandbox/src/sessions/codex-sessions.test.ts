import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { codexThreadExists, readCodexSession } from "./codex-sessions.js";

const roots: string[] = [];
const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "codex-sessions-"));
    roots.push(root);
    return root;
};

// Write a codex rollout at <home>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl.
const writeRollout = async (home: string, threadId: string, lines: unknown[] = [{}]): Promise<void> => {
    const dir = join(home, "sessions", "2026", "07", "11");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `rollout-2026-07-11T00-00-00-${threadId}.jsonl`), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
};

const eventMsg = (payload: unknown): unknown => ({ type: "event_msg", payload });
const responseItem = (payload: unknown): unknown => ({ type: "response_item", payload });

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("finds a thread whose rollout lives in the home's sessions tree", async () => {
    const home = join(await scratch(), "codex");
    await writeRollout(home, "thr-1");
    expect(await codexThreadExists(home, "thr-1")).toBe(true);
});

test("reports a missing thread and an empty home as not existing", async () => {
    const home = join(await scratch(), "codex");
    expect(await codexThreadExists(home, "nope")).toBe(false);
    await writeRollout(home, "thr-2");
    expect(await codexThreadExists(home, "thr-3")).toBe(false);
});

/* THE BACKFILL. A native Codex agent that ran before the daemon kept its own record has its whole conversation
 * in this file and had no way to show it — /agents/:id/transcript answered `{messages: []}` for anything the
 * Claude Code SDK's store didn't hold, so the chat opened blank. The rollout is a lower-level format than the
 * frames the client saw, so the cards are coarser than they were live; that is the trade, and it beats nothing.
 *
 * The conversation is read from `event_msg` and the cards from `response_item`, never both: `response_item`
 * carries the same assistant text a second time (alongside the developer/system messages, which are not the
 * conversation), so reading messages from both would double every reply. */
test("rebuilds a finished thread's conversation and its tool cards", async () => {
    const home = join(await scratch(), "codex");
    await writeRollout(home, "thr-4", [
        { type: "session_meta", payload: { id: "thr-4" } },
        eventMsg({ type: "user_message", message: "audit the traces" }),
        eventMsg({ type: "agent_message", message: "I'll start by locating them." }),
        responseItem({ type: "custom_tool_call", call_id: "call-1", name: "exec", input: "ls /work\nmore lines" }),
        responseItem({ type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "input_text", text: "CLAUDE.md\n" }] }),
        // The raw protocol's copy of the reply, which must NOT become a second bubble.
        responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll start by locating them." }] }),
        eventMsg({ type: "agent_message", message: "Done." }),
    ]);
    expect(await readCodexSession(home, "thr-4", "/work")).toEqual([
        { role: "user", text: "audit the traces" },
        {
            role: "assistant",
            text: "I'll start by locating them.",
            tools: [
                {
                    id: "call-1",
                    name: "exec",
                    category: "other",
                    status: "completed",
                    target: "ls /work",
                    content: [{ type: "text", text: "CLAUDE.md\n" }],
                },
            ],
        },
        { role: "assistant", text: "Done." },
    ]);
});

test("answers empty for a thread with no rollout, rather than failing the read", async () => {
    const home = join(await scratch(), "codex");
    expect(await readCodexSession(home, "gone", "/work")).toEqual([]);
});

test("costs a torn rollout line its own row", async () => {
    const home = join(await scratch(), "codex");
    const dir = join(home, "sessions", "2026", "07", "11");
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, "rollout-2026-07-11T00-00-00-thr-5.jsonl"),
        `${JSON.stringify(eventMsg({ type: "user_message", message: "hi" }))}\n{"type":"event_ms`,
    );
    expect(await readCodexSession(home, "thr-5", "/work")).toEqual([{ role: "user", text: "hi" }]);
});

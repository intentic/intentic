import { WORKSPACE_ROOT } from "@intentic/constants";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { runAgent } from "./agent.js";
import type { QueryFn } from "./sdk-stream.js";

// Force the tmux gate ON. In CI the wrapper is absent so tmuxRunEnabled() is false and no `terminal` frame is
// emitted (agent.test.ts covers that gated-off path); here we stub existsSync true FOR THE WRAPPER'S PATH ONLY
// (keeping the rest of node:fs, and honest answers for every other path) plus the opt-in env so the on-path
// emit is exercised. Only the gate's own path is lied about because everything else in this test's import
// graph deserves the truth: version.ts finds its package.json by walking up with existsSync, and an
// always-true stub stops that walk at src/ and fails the whole suite on a module far from the tmux gate.
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        existsSync: (path: import("node:fs").PathLike) => (String(path).includes("tmux") ? true : actual.existsSync(path)),
    };
});

afterEach(() => vi.unstubAllEnvs());

const fakeQuery = (...messages: unknown[]): QueryFn =>
    async function* () {
        for (const message of messages) {
            yield message as SDKMessage;
        }
    };

const collect = async (queryFn: QueryFn): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of runAgent({ prompt: "run ls", cwd: WORKSPACE_ROOT, signal: new AbortController().signal }, queryFn)) {
        events.push(event);
    }
    return events;
};

test("under the tmux gate, the first Bash tool_use emits ONE `terminal` frame naming the agent session", async () => {
    vi.stubEnv("INTENTIC_AGENT_TMUX", "1");
    const events = await collect(
        fakeQuery(
            {
                type: "assistant",
                session_id: "3f2a9b1c-0000",
                message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls -la" } }] },
            },
            {
                type: "assistant",
                session_id: "3f2a9b1c-0000",
                message: { content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "pwd" } }] },
            },
            { type: "result", subtype: "success" },
        ),
    );
    // Emitted immediately before the FIRST Bash tool frame, and not repeated for the second command.
    expect(events).toEqual([
        { kind: "session", sessionId: "3f2a9b1c-0000" },
        { kind: "terminal", session: "agent-3f2a9b1c" },
        { kind: "tool_call", id: "b1", name: "Bash", category: "execute", status: "in_progress", target: "ls -la" },
        { kind: "tool_call", id: "b2", name: "Bash", category: "execute", status: "in_progress", target: "pwd" },
        { kind: "done" },
    ]);
});

test("re-emits the terminal frame at the first Bash tool_result (session guaranteed to exist by then)", async () => {
    vi.stubEnv("INTENTIC_AGENT_TMUX", "1");
    const events = await collect(
        fakeQuery(
            {
                type: "assistant",
                session_id: "3f2a9b1c-0000",
                message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "la" } }] },
            },
            {
                type: "user",
                session_id: "3f2a9b1c-0000",
                message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "not found", is_error: true }] },
            },
            { type: "result", subtype: "success" },
        ),
    );
    // Backstop for the cold-start race: a second `terminal` frame lands just before the Bash result update.
    expect(events).toEqual([
        { kind: "session", sessionId: "3f2a9b1c-0000" },
        { kind: "terminal", session: "agent-3f2a9b1c" },
        { kind: "tool_call", id: "b1", name: "Bash", category: "execute", status: "in_progress", target: "la" },
        { kind: "terminal", session: "agent-3f2a9b1c" },
        { kind: "tool_call_update", id: "b1", status: "failed", content: [{ type: "text", text: "not found" }] },
        { kind: "done" },
    ]);
});

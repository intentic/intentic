import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { GROK_DIALECT, type Json, KIMI_DIALECT } from "@intentic/acp-events/dialects";
import { fixture } from "@intentic/acp-events/dialects/replay";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { fakeAcpConnection } from "./__fixtures__/fake-acp-agent.js";
import { replayedAcpAgentApp } from "./__fixtures__/replayed-acp-agent.js";
import { createAcpAgent } from "./acp-agent.js";
import type { AcpConnection } from "./acp-connection.js";

// Recorded agent traffic (acp-events dialects/__fixtures__) said by a replaying agent to the real ACP loop and its
// connection routing: a dialect's readings reach the turn, a child session's traffic lands on its parent's, and a
// question the agent asks through its own request parks on the question card.

const cards = parkedCards(memoryFleet().conversations);

const request = (prompt: string): AgentRequest<ContainerCredential> => ({
    execution: unstubbed("execution", {}),
    spec: { prompt, cwd: WORKSPACE_ROOT },
    policy: {},
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: new AbortController().signal,
});

const run = async (connection: AcpConnection, onQuestion?: (event: Extract<AgentEvent, { kind: "question" }>) => void): Promise<AgentEvent[]> => {
    const agent = createAcpAgent({ acquire: async () => connection, drop: () => {} }, { inactivityMs: 10_000, maxTurnMs: 10_000 });
    const events: AgentEvent[] = [];
    for await (const event of agent("replayed", { argv: ["replayed"], env: {} }, request("Fixture prompt"))) {
        events.push(event);
        if (event.kind === "question") {
            onQuestion?.(event);
        }
    }
    return events;
};

test("Grok's subagent and its own calls land on the turn, under the call that spawned it", async () => {
    const events = await run(fakeAcpConnection(replayedAcpAgentApp(fixture("grok-1.0.46-subagent-foreground.jsonl")), { loadSession: false }, GROK_DIALECT));
    expect(events).toContainEqual(expect.objectContaining({ kind: "subagent", id: "call-1", description: "Count note lines" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_call", id: "subagent-1/call-2", parentToolUseId: "call-1", category: "execute" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "subagent_update", id: "call-1", status: "completed", summary: "4" }));
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("without a dialect, the same traffic reads as plain ACP: no subagent, nothing of the child session", async () => {
    const events = await run(fakeAcpConnection(replayedAcpAgentApp(fixture("grok-1.0.46-subagent-foreground.jsonl"))));
    expect(events.some((event) => event.kind === "subagent")).toBe(false);
    expect(events.some((event) => event.kind === "tool_call" && event.id.includes("call-2"))).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("Grok's ask-user request parks on the question card, and the person's pick goes back as Grok's own card sent it", async () => {
    const answers: Json[] = [];
    const lines = fixture("grok-ask-user-question.jsonl");
    const events = await run(fakeAcpConnection(replayedAcpAgentApp(lines, answers), { loadSession: false }, GROK_DIALECT), (event) => {
        setTimeout(() => cards.resolve({ kind: "question", requestId: event.requestId, answers: { [event.questions[0]?.question ?? ""]: ["node:test (Recommended)"] } }), 0);
    });
    expect(events).toContainEqual(expect.objectContaining({ kind: "question", questions: [expect.objectContaining({ question: "Which test approach do you want for the subtract function?" })] }));
    const recorded = lines.find((line) => line.direction === "out" && line.message.id === 0)?.message.result;
    expect(answers[0]).toEqual(recorded);
    // Its exit_plan_mode request is no question: refused as an unknown method, as before any dialect.
    expect(answers[1]).toEqual({ refused: expect.stringContaining("not found") });
});

test("a background shell task does not hold the turn: it ends with the prompt", async () => {
    const events = await run(fakeAcpConnection(replayedAcpAgentApp(fixture("grok-background-task.jsonl")), { loadSession: false }, GROK_DIALECT));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_call_update", id: "call-1", status: "completed" }));
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("Kimi's failing shell call carries its exit code", async () => {
    const events = await run(fakeAcpConnection(replayedAcpAgentApp(fixture("kimi-2.1.1-shell.jsonl")), { loadSession: false }, KIMI_DIALECT));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_call_update", id: "call-1", status: "failed", exitCode: 2 }));
});

test("a turn whose prompt answers while its background subagent still runs stays open until the subagent finishes", async () => {
    // The recording, with the prompt's answer moved to just after the spawn call came back: the parent turn ends while
    // its subagent is still at work, as it does when the model does not wait for it.
    const recorded = fixture("grok-1.0.46-subagent-background.jsonl");
    const answer = recorded.findIndex((line) => line.direction === "in" && line.message.method === undefined && line.message.id !== undefined);
    const acked = recorded.findIndex((line) => JSON.stringify(line.message).includes("Subagent started in background"));
    const lines = [...recorded.slice(0, acked + 1), recorded[answer]!, ...recorded.slice(acked + 1, answer)];
    const events = await run(fakeAcpConnection(replayedAcpAgentApp(lines), { loadSession: false }, GROK_DIALECT));
    expect(events).toContainEqual(expect.objectContaining({ kind: "subagent_update", id: "call-1", status: "completed", summary: "notes.txt, README.md" }));
    expect(events.at(-1)).toEqual({ kind: "done" });
});

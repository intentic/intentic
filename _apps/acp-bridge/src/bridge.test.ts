import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fakeDaemon } from "./__fixtures__/fake-daemon.js";
import { bridgeAgentApp } from "./bridge.js";
import type { BridgeConfig } from "./config.js";

/* The bridge under test is the real agent() app driven through the SDK's in-process composition — real
 * JSON-RPC routing, a fake daemon behind it (the reverse of the sandbox's fake-acp-agent fixture). */

const CONFIG: BridgeConfig = { url: "https://sandbox.example", token: "ibt_test", agent: "claude", model: undefined };

interface Harness {
    readonly updates: SessionNotification[];
    readonly daemon: ReturnType<typeof fakeDaemon>;
    readonly connect: () => ReturnType<ReturnType<typeof client>["connect"]>;
    // The next permission decision(s), consumed in order; default allow-first.
    readonly permissionQueue: ((options: { optionId: string; kind: string }[]) => string)[];
}

const harness = async (scenario: (prompt: string) => AgentEvent[]): Promise<Harness> => {
    const updates: SessionNotification[] = [];
    const daemon = fakeDaemon(scenario);
    const permissionQueue: Harness["permissionQueue"] = [];
    const configDir = await mkdtemp(join(tmpdir(), "acp-bridge-"));
    const app = bridgeAgentApp({ config: CONFIG, clientFor: () => daemon.client, configDir });
    const connect = () =>
        client({ name: "editor" })
            .onRequest(methods.client.session.requestPermission, ({ params }): RequestPermissionResponse => {
                const decide = permissionQueue.shift();
                const optionId = decide !== undefined ? decide(params.options) : (params.options[0]?.optionId ?? "");
                return { outcome: { outcome: "selected", optionId } };
            })
            .onNotification(methods.client.session.update, ({ params }) => {
                updates.push(params);
            })
            .connect(app);
    return { updates, daemon, connect, permissionQueue };
};

const newSession = async (conn: ReturnType<Harness["connect"]>): Promise<string> => {
    const created = await conn.agent.request(methods.agent.session.new, { cwd: "/home/me/mirror", mcpServers: [] });
    return created.sessionId;
};

test("initialize advertises authMethods (registry requirement) and the plan/code modes ride session/new", async () => {
    const { connect } = await harness(() => []);
    const conn = connect();
    const init = await conn.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    expect(init.authMethods?.length).toBeGreaterThan(0);
    expect(init.agentCapabilities?.loadSession).toBe(true);
    const created = await conn.agent.request(methods.agent.session.new, { cwd: "/home/me/mirror", mcpServers: [] });
    expect(created.modes?.availableModes.map((mode) => mode.id)).toEqual(["code", "plan"]);
});

test("a turn streams translated updates, records the provider session, and stops end_turn", async () => {
    const { updates, daemon, connect } = await harness(() => [
        { kind: "session", sessionId: "provider-1" },
        { kind: "delta", text: "Hello" },
        {
            kind: "tool_call",
            id: "t1",
            name: "Edit",
            category: "edit",
            status: "completed",
            locations: [{ path: "src/a.ts" }],
        },
        { kind: "done" },
    ]);
    const conn = connect();
    const sessionId = await newSession(conn);
    const response = await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(response.stopReason).toBe("end_turn");
    expect(updates.map((update) => update.update.sessionUpdate)).toEqual(["agent_message_chunk", "tool_call"]);
    const toolCall = updates[1]?.update;
    expect(toolCall?.sessionUpdate === "tool_call" && toolCall.locations?.[0]?.path).toBe("/home/me/mirror/src/a.ts");
    expect(daemon.prompts).toEqual(["hi"]);

    // The next prompt resumes the recorded provider session.
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "again" }] });
    expect(daemon.prompts).toHaveLength(2);
});

test("a plan frame round-trips through request_permission: approve posts the decision", async () => {
    const { updates, daemon, connect, permissionQueue } = await harness((prompt) =>
        prompt.includes("plan me")
            ? [
                  { kind: "plan", decisionId: "d1", text: "1. do it" },
                  { kind: "delta", text: "executing" },
                  { kind: "done" },
              ]
            : [{ kind: "done" }],
    );
    permissionQueue.push((options) => options.find((option) => option.optionId === "approve")?.optionId ?? "");
    const conn = connect();
    const sessionId = await newSession(conn);
    await conn.agent.request(methods.agent.session.setMode, { sessionId, modeId: "plan" });
    const response = await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "plan me" }] });
    expect(response.stopReason).toBe("end_turn");
    expect(daemon.decisions).toEqual([{ decisionId: "d1", approve: true }]);
    // The plan text rode a Review-plan tool call, completed on approval.
    const kinds = updates.map((update) => update.update.sessionUpdate);
    expect(kinds).toEqual(["tool_call", "tool_call_update", "agent_message_chunk"]);
});

test("a plan rejection posts approve:false with the canned feedback", async () => {
    const { daemon, connect, permissionQueue } = await harness(() => [
        { kind: "plan", decisionId: "d2", text: "plan" },
        { kind: "done" },
    ]);
    permissionQueue.push((options) => options.find((option) => option.optionId === "reject")?.optionId ?? "");
    const conn = connect();
    const sessionId = await newSession(conn);
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "go" }] });
    expect(daemon.decisions).toEqual([{ decisionId: "d2", approve: false, feedback: "Revise the plan." }]);
});

test("questions become one permission prompt each; a pick answers, a dismiss cancels", async () => {
    const question = { question: "Which db?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "" }] };
    const { daemon, connect, permissionQueue } = await harness(() => [
        { kind: "question", requestId: "q1", questions: [question] },
        { kind: "done" },
    ]);
    permissionQueue.push(() => "Postgres");
    const conn = connect();
    const sessionId = await newSession(conn);
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "ask" }] });
    expect(daemon.answers).toEqual([{ requestId: "q1", answers: { "Which db?": ["Postgres"] } }]);

    permissionQueue.push(() => "__dismiss");
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "ask" }] });
    expect(daemon.answers[1]).toEqual({ requestId: "q1" });
});

test("an error frame fails the prompt as a JSON-RPC error AFTER the stream drains", async () => {
    const { connect } = await harness(() => [
        { kind: "delta", text: "partial" },
        { kind: "error", message: "model exploded" },
        { kind: "done" },
    ]);
    const conn = connect();
    const sessionId = await newSession(conn);
    await expect(conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "x" }] })).rejects.toMatchObject({
        data: { details: "model exploded" },
    });
});

test("no configuration ⇒ session/new fails auth_required (the editor then runs an auth method)", async () => {
    const daemon = fakeDaemon(() => []);
    // No `config` and an isolated config dir: resolveConfig finds nothing (env vars would leak in only if the
    // test runner exported them — the bridge env names are specific enough not to).
    const app = bridgeAgentApp({ clientFor: () => daemon.client, configDir: await mkdtemp(join(tmpdir(), "acp-none-")) });
    const conn = client({ name: "editor" }).connect(app);
    await expect(conn.agent.request(methods.agent.session.new, { cwd: "/x", mcpServers: [] })).rejects.toMatchObject({ code: -32000 });
});

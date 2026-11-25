import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { fakeDaemon } from "./__fixtures__/fake-daemon.js";
import { bridgeAgentApp } from "./bridge.js";
import type { BridgeConfig } from "./config.js";

/* The bridge under test is the real agent() app driven through the SDK's in-process composition: real JSON-RPC routing. */

const CONFIG: BridgeConfig = { url: "https://sandbox.example", token: "ict_test", agent: "claude", model: undefined };

interface Harness {
    readonly updates: SessionNotification[];
    readonly daemon: ReturnType<typeof fakeDaemon>;
    readonly connect: () => ReturnType<ReturnType<typeof client>["connect"]>;
    // The next permission decision(s), consumed in order; default allow-first. Undefined answers as the editor's cancel.
    readonly permissionQueue: ((options: { optionId: string; name: string; kind: string }[]) => string | undefined)[];
    // Every request_permission the editor was shown, in order.
    readonly permissionRequests: RequestPermissionRequest[];
}

const harness = async (scenario: (prompt: string) => AgentEvent[]): Promise<Harness> => {
    const updates: SessionNotification[] = [];
    const daemon = fakeDaemon(scenario);
    const permissionQueue: Harness["permissionQueue"] = [];
    const permissionRequests: RequestPermissionRequest[] = [];
    const configDir = await mkdtemp(join(tmpdir(), "acp-bridge-"));
    const app = bridgeAgentApp({ config: CONFIG, clientFor: () => daemon.client, configDir });
    const connect = () =>
        client({ name: "editor" })
            .onRequest(methods.client.session.requestPermission, ({ params }): RequestPermissionResponse => {
                permissionRequests.push(params);
                const decide = permissionQueue.shift();
                const optionId = decide !== undefined ? decide(params.options) : (params.options[0]?.optionId ?? "");
                return optionId === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } };
            })
            .onNotification(methods.client.session.update, ({ params }) => {
                updates.push(params);
            })
            .connect(app);
    return { updates, daemon, connect, permissionQueue, permissionRequests };
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
            ? [{ kind: "plan", requestId: "d1", text: "1. do it" }, { kind: "delta", text: "executing" }, { kind: "done" }]
            : [{ kind: "done" }],
    );
    permissionQueue.push((options) => options.find((option) => option.optionId === "approve")?.optionId ?? "");
    const conn = connect();
    const sessionId = await newSession(conn);
    await conn.agent.request(methods.agent.session.setMode, { sessionId, modeId: "plan" });
    const response = await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "plan me" }] });
    expect(response.stopReason).toBe("end_turn");
    // No mode named: the daemon restores the posture the turn started in (this card has no room to ask).
    expect(daemon.replies).toEqual([{ kind: "plan", requestId: "d1", approve: true }]);
    // The plan text rode a Review-plan tool call, completed on approval.
    const kinds = updates.map((update) => update.update.sessionUpdate);
    expect(kinds).toEqual(["tool_call", "tool_call_update", "agent_message_chunk"]);
});

test("a plan rejection posts approve:false with the canned feedback", async () => {
    const { daemon, connect, permissionQueue } = await harness(() => [{ kind: "plan", requestId: "d2", text: "plan" }, { kind: "done" }]);
    permissionQueue.push((options) => options.find((option) => option.optionId === "reject")?.optionId ?? "");
    const conn = connect();
    const sessionId = await newSession(conn);
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "go" }] });
    expect(daemon.replies).toEqual([{ kind: "plan", requestId: "d2", approve: false, feedback: "Revise the plan." }]);
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
    expect(daemon.replies).toEqual([{ kind: "question", requestId: "q1", answers: { "Which db?": ["Postgres"] } }]);

    permissionQueue.push(() => "__dismiss");
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "ask" }] });
    expect(daemon.replies[1]).toEqual({ kind: "question", requestId: "q1", cancelled: true });
});

test("a permission card round-trips through request_permission with its own title and command: once, then always", async () => {
    const { updates, daemon, connect, permissionQueue, permissionRequests } = await harness(() => [
        {
            kind: "permission",
            requestId: "p1",
            toolName: "Bash",
            title: "This command deletes a folder outside the workspace",
            displayName: "Run command",
            explain: "Removes the build cache in /tmp.",
            program: { text: "rm -rf /tmp/build", language: "bash", truncated: false, spans: [{ start: 0, end: 6 }] },
            alwaysLabel: "Always: allow rm -rf under /tmp",
        },
        { kind: "delta", text: "removed" },
        { kind: "done" },
    ]);
    permissionQueue.push(() => "once");
    const conn = connect();
    const sessionId = await newSession(conn);
    const response = await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "clean" }] });
    expect(response.stopReason).toBe("end_turn");
    expect(daemon.replies).toEqual([{ kind: "permission", requestId: "p1", decision: "once" }]);
    // The card's always-label is offered as the always option; "everything" never is.
    expect(permissionRequests[0]?.toolCall).toEqual({ toolCallId: "permission-p1", title: "This command deletes a folder outside the workspace" });
    expect(permissionRequests[0]?.options).toEqual([
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always: allow rm -rf under /tmp", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
    ]);
    // The judge's sentence and the command itself ride the tool call, so the person can judge it in the editor.
    expect(updates[0]?.update).toEqual({
        sessionUpdate: "tool_call",
        toolCallId: "permission-p1",
        title: "This command deletes a folder outside the workspace",
        kind: "execute",
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: "Removes the build cache in /tmp.\n\n```bash\nrm -rf /tmp/build\n```" } }],
        locations: [],
    });
    expect(updates[1]?.update).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "permission-p1", status: "completed" });
    expect(updates.map((update) => update.update.sessionUpdate)).toEqual(["tool_call", "tool_call_update", "agent_message_chunk"]);

    permissionQueue.push(() => "always");
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "clean" }] });
    expect(daemon.replies[1]).toEqual({ kind: "permission", requestId: "p1", decision: "always" });
});

test("a permission card without an always-label offers no always; a rejection and a cancel both deny", async () => {
    const { updates, daemon, connect, permissionQueue, permissionRequests } = await harness(() => [
        { kind: "permission", requestId: "p2", toolName: "Write", displayName: "Write file", path: "src/a.ts", reason: "rule" },
        { kind: "done" },
    ]);
    permissionQueue.push(() => "deny");
    const conn = connect();
    const sessionId = await newSession(conn);
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "write" }] });
    expect(permissionRequests[0]?.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
    expect(daemon.replies).toEqual([{ kind: "permission", requestId: "p2", decision: "deny" }]);
    // No title on the card: its short phrase stands in, and its file is a location on the editor's own tree.
    expect(updates[0]?.update).toEqual({
        sessionUpdate: "tool_call",
        toolCallId: "permission-p2",
        title: "Write file",
        kind: "other",
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: "src/a.ts\n\nAsked because: rule" } }],
        locations: [{ path: "/home/me/mirror/src/a.ts" }],
    });
    expect(updates[1]?.update).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "permission-p2", status: "failed" });

    // The editor cancelling the prompt has no answer of its own on the wire: it is a deny.
    permissionQueue.push(() => undefined);
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "write" }] });
    expect(daemon.replies[1]).toEqual({ kind: "permission", requestId: "p2", decision: "deny" });
});

test("a browser hand-over has no ACP control: the editor is told once to answer it in the sandbox app", async () => {
    const { updates, daemon, connect, permissionRequests } = await harness(() => [
        { kind: "browser_help", requestId: "b1", session: "s1", account: "github", message: "Solve the captcha on github.com." },
        { kind: "done" },
    ]);
    const conn = connect();
    const sessionId = await newSession(conn);
    const response = await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "sign in" }] });
    expect(response.stopReason).toBe("end_turn");
    expect(updates.map((update) => update.update)).toEqual([
        {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: "\n\nThe agent is waiting on you in the sandbox app; answer it there and the turn goes on. It asks: Solve the captcha on github.com.\n\n",
            },
        },
    ]);
    expect(permissionRequests).toEqual([]);
    expect(daemon.replies).toEqual([]);
});

test("an error frame fails the prompt as a JSON-RPC error AFTER the stream drains", async () => {
    const { connect } = await harness(() => [{ kind: "delta", text: "partial" }, { kind: "error", message: "model exploded" }, { kind: "done" }]);
    const conn = connect();
    const sessionId = await newSession(conn);
    await expect(conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "x" }] })).rejects.toMatchObject({
        data: { details: "model exploded" },
    });
});

test("no configuration ⇒ session/new fails auth_required (the editor then runs an auth method)", async () => {
    const daemon = fakeDaemon(() => []);
    // No `config` and an isolated config dir: resolveConfig finds nothing (env vars would leak in only if the
    // test runner exported them: the bridge env names are specific enough not to).
    const app = bridgeAgentApp({ clientFor: () => daemon.client, configDir: await mkdtemp(join(tmpdir(), "acp-none-")) });
    const conn = client({ name: "editor" }).connect(app);
    await expect(conn.agent.request(methods.agent.session.new, { cwd: "/x", mcpServers: [] })).rejects.toMatchObject({ code: -32000 });
});

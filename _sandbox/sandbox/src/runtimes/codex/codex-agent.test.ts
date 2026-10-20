import { HISTORY_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ToolCallContent } from "@intentic/sandbox-contract/events/requests";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { sleep } from "@intentic/base/async";
import type { AgentRequest, CodexCredential, TurnHooks } from "../../agent/providers/agent-request.js";
import { SteeringQueue } from "../../agent/checkpoints/agent-steering.js";
import { WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { forgetNamespaceEntry, registerMountEntry } from "../../workload/namespace-entry.js";
import { fakeCodexRunner } from "./codex-app-server.testing.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import type { CodexEvent, CodexFailureInfo, CodexItem, CodexRunner, CodexTurn } from "./codex-app-server.js";
import { createCodexAgent, UNGATED_CALL, UNGATED_LIST } from "./codex-agent.js";
import { LIMIT_WAIT_HANDED_OVER } from "./turn/limit-wait.js";
import { RATE_LIMIT_PATIENCE_MS } from "../decorators/vendor-errors.js";
import { createTurnRelay, type TurnRelay } from "../daemon-tools/turn-relay.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

const createTestAgent = (runner: CodexRunner, codexHome = "/home") => createCodexAgent({ codexHome, runner });

const request: AgentRequest<CodexCredential> = {
    execution: unstubbed("execution", {}),
    spec: { prompt: "add a /ping route", cwd: WORKSPACE_ROOT },
    policy: {},
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: new AbortController().signal,
};

// Collects all events; onPlan/onQuestion schedule their answer after the generator parks on the pending-request bridge,
// hence the setTimeout (the yield suspends before wait() registers).
const collect = async (
    agent: ReturnType<typeof createCodexAgent>,
    turnRequest: Parameters<ReturnType<typeof createCodexAgent>>[0],
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
    onQuestion?: (requestId: string) => { answers?: Record<string, string[]>; cancelled?: boolean },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => cards.resolve({ kind: "plan", requestId: event.requestId, ...decision }), 0);
        }
        if (event.kind === "question" && onQuestion !== undefined) {
            const decision = onQuestion(event.requestId);
            setTimeout(() => cards.resolve({ kind: "question", requestId: event.requestId, ...decision }), 0);
        }
    }
    return events;
};

test("a turn maps thread events onto session, deltas, thinking, tools, todos, usage, and done", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-1" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "r1", type: "reasoning", text: "planning the edit" } },
        { type: "item.started", item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "", status: "in_progress" } },
        {
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "1 passed", exit_code: 0, status: "completed" },
        },
        { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "src/app.ts", kind: "update" }], status: "completed" } },
        { type: "item.updated", item: { id: "t1", type: "todo_list", items: [{ text: "add route", completed: false }] } },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Added the route." } },
        {
            type: "turn.completed",
            usage: { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 2 },
        },
    ]);
    const events = await collect(createTestAgent(runner, `${WORKSPACE_ROOT}/${STATE_DIR}/secrets/auth/codex`), request);
    expect(events).toEqual([
        { kind: "session", sessionId: "thr-1" },
        { kind: "thinking", text: "planning the edit" },
        { kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
        { kind: "tool_call_update", id: "c1", status: "completed", content: [{ type: "text", text: "1 passed" }] },
        {
            kind: "tool_call",
            id: "f1",
            name: "Edit",
            category: "edit",
            status: "completed",
            target: "update src/app.ts",
            locations: [{ path: "src/app.ts" }],
        },
        { kind: "todos", items: [{ content: "add route", status: "pending" }] },
        { kind: "delta", text: "Added the route." },
        // Codex only reports a completed agent_message, so every delta is a whole prose block and closes one.
        { kind: "text_end" },
        { kind: "usage", inputTokens: 6, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 1 },
        { kind: "done" },
    ]);
});

// Codex's own subagents drawn as the Claude loop's are: the spawn call's card carries the subagent it started, its
// thread's work nests under that card, and what Codex says of it moves its standing; the turn's usage counts its spend.
test("a Codex subagent sits on its spawn call's card, its work under it, its report and spend its own", async () => {
    type Collab = Extract<CodexItem, { type: "collab_agent_tool_call" }>;
    const spawn = (status: Collab["status"], receivers: Collab["receivers"], states: Collab["states"]): Collab => ({
        id: "spawn-1",
        type: "collab_agent_tool_call",
        tool: "spawnAgent",
        status,
        prompt: "Port the purge job\nRetire rows past 30 days.",
        model: "gpt-5.6-luna",
        receivers,
        states,
    });
    const wait = (status: Collab["status"], states: Collab["states"]): Collab => ({ id: "wait-1", type: "collab_agent_tool_call", tool: "wait", status, receivers: ["thr-child"], states });
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-1" },
        { type: "item.started", item: spawn("in_progress", [], {}) },
        { type: "item.completed", item: spawn("completed", ["thr-child"], { "thr-child": { status: "pendingInit" } }) },
        { type: "item.started", item: { id: "cmd-c1", type: "command_execution", command: "rg purge", aggregated_output: "", status: "in_progress" }, parent: "spawn-1" },
        { type: "item.completed", item: { id: "msg-c1", type: "agent_message", text: "Ported." }, parent: "spawn-1" },
        { type: "subagent.usage", parent: "spawn-1", input: 500, output: 50 },
        { type: "subagent.ended", parent: "spawn-1", status: "completed" },
        { type: "item.started", item: wait("in_progress", {}) },
        { type: "item.completed", item: wait("completed", { "thr-child": { status: "completed", message: "Ported." } }) },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 2 } },
    ]);
    const events = await collect(createTestAgent(runner), request);
    expect(events).toEqual([
        { kind: "session", sessionId: "thr-1" },
        { kind: "tool_call", id: "spawn-1", name: "Spawn agent", category: "other", status: "in_progress", target: "Port the purge job" },
        { kind: "subagent", id: "spawn-1", subagentKind: "subagent", description: "Port the purge job", model: "gpt-5.6-luna" },
        { kind: "tool_call_update", id: "spawn-1", status: "completed" },
        { kind: "subagent_update", id: "spawn-1", status: "pending" },
        { kind: "tool_call", id: "cmd-c1", name: "Bash", category: "execute", status: "in_progress", target: "rg purge", parentToolUseId: "spawn-1" },
        { kind: "subagent_update", id: "spawn-1", toolUses: 1, lastTool: "Bash" },
        { kind: "delta", text: "Ported.", parentToolUseId: "spawn-1" },
        { kind: "text_end", parentToolUseId: "spawn-1" },
        { kind: "subagent_update", id: "spawn-1", tokens: 550 },
        { kind: "subagent_update", id: "spawn-1", status: "completed", summary: "Ported." },
        { kind: "tool_call", id: "wait-1", name: "Wait for agents", category: "other", status: "in_progress" },
        { kind: "tool_call_update", id: "wait-1", status: "completed" },
        { kind: "subagent_update", id: "spawn-1", status: "completed", summary: "Ported." },
        { kind: "usage", inputTokens: 506, outputTokens: 55, cacheReadTokens: 3, cacheCreationTokens: 1 },
        { kind: "done" },
    ]);
});

// Codex runs the same @playwright/mcp server, whose answer names the file; the card carries that picture, as Claude's does.
test("a Codex browser screenshot settles its card with the picture its answer names", async () => {
    const answer = "### Result\n- [Screenshot of viewport](.intentic/records/artifacts/browser/page-1.png)";
    const { runner } = fakeCodexRunner([
        { type: "item.started", item: { id: "s1", type: "mcp_tool_call", server: "web", tool: "browser_take_screenshot", status: "in_progress" } },
        {
            type: "item.completed",
            item: {
                id: "s1",
                type: "mcp_tool_call",
                server: "web",
                tool: "browser_take_screenshot",
                status: "completed",
                // The normalized item keeps a block's type and text only; the picture block arrives as a bare `image`.
                result: { content: [{ type: "text", text: answer }, { type: "image" }] },
            },
        },
    ]);
    const events = await collect(createTestAgent(runner), {
        ...request,
        tools: { ...request.tools, browserOutputDir: `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser` },
    });
    expect(events.filter((event) => event.kind === "tool_call_update")).toEqual([
        {
            kind: "tool_call_update",
            id: "s1",
            status: "completed",
            content: [
                { type: "text", text: answer },
                { type: "image", path: `${STATE_DIR}/records/artifacts/browser/page-1.png` },
            ],
        },
    ]);
});

test("the turn runs full-access with approvals off, resumes the session, and pins CODEX_HOME", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner, `${WORKSPACE_ROOT}/${STATE_DIR}/secrets/auth/codex`), {
        ...request,
        spec: { ...request.spec, sessionId: "thr-9", model: "gpt-5-codex", effort: "max" },
        tools: { ...request.tools, cliEnv: { DISCORD_BOT_TOKEN: "tok" } },
    });
    expect(calls).toHaveLength(1);
    const turn = calls[0]!;
    expect(turn.sessionId).toBe("thr-9");
    expect(turn.options).toEqual({
        workingDirectory: "/work",
        sandboxMode: "danger-full-access",
        // untrusted on every turn: the standing floor means something could always refuse.
        approvalPolicy: "untrusted",
        model: "gpt-5-codex",
        // Codex has its own `max`, so the pick travels as picked rather than being spent one rung down.
        modelReasoningEffort: "max",
    });
    expect(turn.env["CODEX_HOME"]).toBe("/work/.intentic/secrets/auth/codex");
    expect(turn.env["DISCORD_BOT_TOKEN"]).toBe("tok");
});

// The stamp is what the leftovers sweep reclaims by and what the Agents board attributes CPU and memory by. A turn with no
// conversation invents none, so it keeps whatever this process was started with: nothing for a daemon, the running
// turn's own stamp when the suite runs inside one.
test("app-server carries the owner stamp of the conversation it works for, over any it inherited", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    const agent = createTestAgent(runner, `${WORKSPACE_ROOT}/${STATE_DIR}/secrets/auth/codex`);
    await collect(agent, { ...request, spec: { ...request.spec, conversationId: "conv-7" } });
    await collect(agent, request);
    expect(calls.map((turn) => turn.env[WORKLOAD_ENV])).toEqual(["conv-7", process.env[WORKLOAD_ENV]]);
});

test("a subscription turn uses the translator bearer and the actor marker that unlocks image generation", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner, `${WORKSPACE_ROOT}/${STATE_DIR}/secrets/auth/codex`), {
        ...request,
        spec: { ...request.spec, model: "gpt-5.5" },
        credential: {
            kind: "codex-endpoint",
            baseUrl: "http://127.0.0.1:8788",
            authToken: "intentic-translator-local",
        },
    });
    const turn = calls[0]!;
    // The bearer rides CODEX_API_KEY (env_key), not an OAuth token in a home.
    expect(turn.env["CODEX_API_KEY"]).toBe("intentic-translator-local");
    // A full model_providers block pinned to the translator's /v1, Responses wire format, WS disabled.
    expect(turn.modelProvider).toBe("translator");
    expect(turn.config).toEqual({
        "model_providers.translator": {
            name: "translator",
            base_url: "http://127.0.0.1:8788/v1",
            wire_api: "responses",
            env_key: "CODEX_API_KEY",
            http_headers: { "x-openai-actor-authorization": "intentic" },
            supports_websockets: false,
        },
        "tools.experimental_request_user_input.enabled": true,
        project_doc_max_bytes: 0,
    });
});

// Another provider's route rides its own provider block: the route's versioned root, its bearer in the same env seam,
// the window Codex cannot know of a model outside OpenAI's catalog, and OpenAI's hosted tools off.
test("a hosted route names its own provider block, its window, and no OpenAI-only tools", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner), {
        ...request,
        spec: { ...request.spec, model: "glm-5.3" },
        credential: {
            kind: "codex-endpoint",
            baseUrl: "https://api.z.ai/api",
            authToken: "zai-key",
            hosted: { id: "intentic-zai", path: "/v1", contextWindow: 1_048_576 },
        },
    });
    const turn = calls[0]!;
    expect(turn.env["CODEX_API_KEY"]).toBe("zai-key");
    expect(turn.modelProvider).toBe("intentic-zai");
    expect(turn.config).toEqual({
        "model_providers.intentic-zai": {
            name: "intentic-zai",
            base_url: "https://api.z.ai/api/v1",
            wire_api: "responses",
            env_key: "CODEX_API_KEY",
            supports_websockets: false,
        },
        web_search: "disabled",
        "features.image_generation": false,
        model_context_window: 1_048_576,
        "tools.experimental_request_user_input.enabled": true,
        project_doc_max_bytes: 0,
    });
});

test("a native (account) turn carries no provider config: Codex uses its own credential resolution", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner, `${WORKSPACE_ROOT}/${STATE_DIR}/secrets/auth/codex`), {
        ...request,
        spec: { ...request.spec, model: "gpt-5-codex" },
    });
    // The question tool and the AGENTS.md budget are the keys every turn carries; nothing here names a provider or a
    // credential.
    expect(calls[0]!.config).toEqual({ "tools.experimental_request_user_input.enabled": true, project_doc_max_bytes: 0 });
    expect(calls[0]!.env["CODEX_API_KEY"]).toBeUndefined();
});

// Every runtime projects the same remote list, so a granted machine, extension card or browser reaches Codex too.
test("the turn's remote MCP servers ride Codex's per-thread config as http servers with their bearer and bound", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner), {
        ...request,
        tools: {
            ...request.tools,
            remote: [
                { name: "browser", url: "http://127.0.0.1:8787/mcp/browser", token: "bearer", timeoutMs: 120_000 },
                { name: "saldeo", url: "https://saldeo.example/mcp" },
            ],
        },
    });

    expect(calls[0]!.config).toEqual({
        "mcp_servers.browser": { url: "http://127.0.0.1:8787/mcp/browser", http_headers: { Authorization: "Bearer bearer" }, tool_timeout_sec: 120 },
        "mcp_servers.saldeo": { url: "https://saldeo.example/mcp" },
        "tools.experimental_request_user_input.enabled": true,
        project_doc_max_bytes: 0,
    });
});

test("a failed command surfaces its output as a failed update", async () => {
    const { runner } = fakeCodexRunner([
        {
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "1 failed", exit_code: 1, status: "failed" },
        },
    ]);
    const events = await collect(createTestAgent(runner), request);
    expect(events).toEqual([
        { kind: "tool_call_update", id: "c1", status: "failed", content: [{ type: "text", text: "1 failed" }] },
        { kind: "done" },
    ]);
});

test("attached images ride as native inputs while other files are referenced in the prompt", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner), {
        ...request,
        spec: {
            ...request.spec,
            attachments: [
                `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/attachments/a/shot.png`,
                `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/attachments/b/report.pdf`,
            ],
        },
    });
    expect(calls[0]!.images).toEqual(["/work/.intentic/records/artifacts/attachments/a/shot.png"]);
    expect(calls[0]!.prompt).toContain("/work/.intentic/records/artifacts/attachments/b/report.pdf");
    expect(calls[0]!.prompt).not.toContain("shot.png");
});

test("a plan turn sends attached images on the first planning turn only: the resumed thread keeps them", async () => {
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-6" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    await collect(
        createTestAgent(runner),
        {
            ...request,
            spec: { ...request.spec, attachments: [`${WORKSPACE_ROOT}/a/shot.png`] },
            policy: { ...request.policy, permissionMode: "plan" as const },
        },
        () => ({
            approve: true,
        }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.images).toEqual(["/work/a/shot.png"]);
    expect(calls[1]!.images).toBeUndefined();
});

test("a plan turn proposes read-only, then executes full-access on the same thread after approval", async () => {
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-2" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route, then test." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => ({
        approve: true,
    }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-2" },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route, then test." },
        // requestId lets a replaying client skip rebuilding and re-asking for the same plan card.
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
        // An approved plan moves the conversation out of planning, as the Claude loop's approval does.
        { kind: "mode", mode: "bypassPermissions" },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.options.sandboxMode).toBe("read-only");
    expect(calls[0]!.prompt).toContain("add a /ping route");
    expect(calls[1]!.sessionId).toBe("thr-2");
    expect(calls[1]!.options.sandboxMode).toBe("danger-full-access");
});

test("a rejected plan loops another read-only planning turn carrying the feedback", async () => {
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-3" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan v1" } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Plan v2" } }],
        [{ type: "item.completed", item: { id: "m3", type: "agent_message", text: "Executed." } }],
    );
    let planCount = 0;
    const events = await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => {
        planCount += 1;
        return planCount === 1 ? { approve: false, feedback: "use fastify" } : { approve: true };
    });

    expect(events.filter((event) => event.kind === "plan").map((event) => (event as { text: string }).text)).toEqual(["Plan v1", "Plan v2"]);
    expect(events.slice(-3)).toEqual([{ kind: "delta", text: "Executed." }, { kind: "text_end" }, { kind: "done" }]);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.prompt).toContain("use fastify");
    expect(calls[1]!.options.sandboxMode).toBe("read-only");
    expect(calls[1]!.sessionId).toBe("thr-3");
});

test("a plan turn that fails after holding a message emits the error and NO plan frame", async () => {
    const { runner, calls } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-7" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Partial plan." } },
        { type: "turn.failed", error: { message: "Payment Required" } },
    ]);
    const events = await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } });
    expect(events).toEqual([{ kind: "session", sessionId: "thr-7" }, { kind: "error", message: "Payment Required" }, { kind: "done" }]);
    expect(events.some((event) => event.kind === "plan")).toBe(false);
    expect(calls).toHaveLength(1);
});

// A 400 naming a parameter never sent; coded a provider outage, not model-invalid, so it retries.
const UNSENT_PARAMETER_400 =
    '{"error":{"type":"invalid_request_error","code":"invalid_parameter","message":"prompt_cache_retention is not supported on this model","param":"prompt_cache_retention"}}';

test("a parameter the turn never sent is coded as an outage, so the turn comes back instead of dying", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-9" },
        { type: "turn.failed", error: { message: UNSENT_PARAMETER_400 } },
    ]);
    const events = await collect(createTestAgent(runner), request);
    const failure = events.find((event) => event.kind === "error") as { code?: string; message: string } | undefined;
    expect(failure?.code).toBe("provider-outage");
    // Provider's own words are kept, not a gloss, so the reader sees what was refused.
    expect(failure?.message).toContain("prompt_cache_retention");
    // Not the bad-pick code, which would make the client drop a pinned model that wasn't at fault.
    expect(failure?.code).not.toBe("codex-model-invalid");
});

// Codex's fallback-metadata warning; lands before turn.started for any uncompiled model.
const ADVISORY = "Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";

test("a non-fatal advisory is tagged rather than surfaced as a failure, and the turn's answer still lands", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-8" },
        { type: "error", message: ADVISORY },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-8" },
        // Coded, so the client renders a muted notice instead of the red error line under a turn that worked.
        { kind: "error", code: "codex-advisory", message: ADVISORY },
        { kind: "delta", text: "ok" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

// Every hosted model is outside OpenAI's catalog, so the notice would come every turn; the route already said the window.
test("a hosted route's turn drops the fallback-metadata advisory its model always earns", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-9" },
        { type: "error", message: ADVISORY },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } },
    ]);
    const hosted: AgentRequest<CodexCredential> = {
        ...request,
        credential: { kind: "codex-endpoint", baseUrl: "http://127.0.0.1:8788", authToken: "local", hosted: { id: "intentic-kimi", path: "/v1" } },
    };
    expect(await collect(createTestAgent(runner), hosted)).toEqual([
        { kind: "session", sessionId: "thr-9" },
        { kind: "delta", text: "ok" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a plan turn survives an advisory and still proposes its plan", async () => {
    // An advisory must not mark the planning phase errored, or plan-emulation would abandon a turn that produced a
    // plan.
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-10" },
            { type: "error", message: ADVISORY },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => ({
        approve: true,
    }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-10" },
        { kind: "error", code: "codex-advisory", message: ADVISORY },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route." },
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
        // An approved plan moves the conversation out of planning, as the Claude loop's approval does.
        { kind: "mode", mode: "bypassPermissions" },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    // The approved plan really executed: a second, full-access turn on the same thread.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.sandboxMode).toBe("danger-full-access");
});

// Codex's resume warning, worded as codex-rs/core/src/session/mod.rs formats it when the thread's last recorded model
// isn't the one now picked. It fires on every resume after a model switch, including the automatic one this sandbox
// makes when a provider 503s.
const RESUMED_ELSEWHERE =
    "This session was recorded with model `gpt-5.6-sol` but is resuming with `gpt-6-astra`. " +
    "Consider switching back to `gpt-5.6-sol` as it may affect Codex performance.";

test("the resume model-mismatch warning is dropped, since switching model mid-thread is this chat's own move", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-15" },
        { type: "warning", message: RESUMED_ELSEWHERE },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } },
    ]);
    // No frame at all, not even the muted line: the chat already prints its own "Switched to ..." notice, and Codex's
    // advice to switch back argues with a model the reader picked on purpose.
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-15" },
        { kind: "delta", text: "ok" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("an unrecognized warning is muted rather than reddening the turn, and a plan turn still proposes its plan", async () => {
    // A warning that marked the phase errored would have plan-emulation abandon a turn the CLI only commented on.
    const WARNING = "Something the CLI wanted to mention.";
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-16" },
            { type: "warning", message: WARNING },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => ({
        approve: true,
    }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-16" },
        // Coded, so the client renders it muted: the warning channel by construction carries advisories, never failures.
        { kind: "error", code: "codex-advisory", message: WARNING },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route." },
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
        // An approved plan moves the conversation out of planning, as the Claude loop's approval does.
        { kind: "mode", mode: "bypassPermissions" },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    expect(calls).toHaveLength(2);
});

// Codex's stream retry arrives as an error notification marked willRetry, its sentence carrying the counters.
const STREAM_RETRY = "Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)";
const PROCESS_EXIT = "Codex app-server exited (1): connection closed";

test("an in-turn stream retry is a wait, not a failure: the turn's answer still lands", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-11" },
        { type: "error", message: STREAM_RETRY, willRetry: true },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "back" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-11" },
        // Same frame the Claude path emits for its own retries, so the loader line behaves the same across runtimes.
        { kind: "provider_retry", attempt: 1, maxAttempts: 5 },
        { kind: "delta", text: "back" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a plan turn survives a stream retry and still proposes its plan", async () => {
    // A retry that marked the phase errored would have plan-emulation abandon a turn the CLI recovered by itself.
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-12" },
            { type: "error", message: STREAM_RETRY, willRetry: true },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => ({
        approve: true,
    }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-12" },
        { kind: "provider_retry", attempt: 1, maxAttempts: 5 },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route." },
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
        // An approved plan moves the conversation out of planning, as the Claude loop's approval does.
        { kind: "mode", mode: "bypassPermissions" },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    expect(calls).toHaveLength(2);
});

test("a stream retry doesn't stand in for the real failure when the retries run out", async () => {
    // Retry notices must not count as this turn's surfaced error, or the real failure that follows would arrive silent.
    const runner: CodexRunner = async function* () {
        yield { type: "error", message: STREAM_RETRY, willRetry: true } as CodexEvent;
        throw new Error(PROCESS_EXIT);
    };
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "provider_retry", attempt: 1, maxAttempts: 5 },
        { kind: "error", message: PROCESS_EXIT },
        { kind: "done" },
    ]);
});

test("an advisory doesn't stand in for the real failure when the turn then dies", async () => {
    // surfacedError stops the exit wrapper from clobbering an actionable message; an advisory must not count as one.
    const runner: CodexRunner = async function* () {
        yield { type: "error", message: ADVISORY } as CodexEvent;
        throw new Error(PROCESS_EXIT);
    };
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "error", code: "codex-advisory", message: ADVISORY },
        { kind: "error", message: PROCESS_EXIT },
        { kind: "done" },
    ]);
});

test("a context-compaction item is the compact lifecycle frame, and the turn's answer still lands", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-13" },
        { type: "item.completed", item: { id: "compact-1", type: "context_compaction" } },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "carrying on" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-13" },
        // Same frame the Claude path yields off compact_boundary: a muted notice, nothing on the error channel.
        { kind: "compact", trigger: "auto" },
        { kind: "delta", text: "carrying on" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

// Codex's post-compaction heads-up, worded as codex-rs/core/src/compact.rs emits it; it follows every auto-compaction,
// on top of the context_compaction item.
const COMPACTED_HEADS_UP =
    "Heads up: Long threads and multiple compactions can cause the model to be less accurate. " +
    "Start a new thread when possible to keep threads small and targeted.";

test("the post-compaction heads-up is dropped, so one compaction reads as one notice", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-17" },
        { type: "item.completed", item: { id: "compact-1", type: "context_compaction" } },
        { type: "warning", message: COMPACTED_HEADS_UP },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "carrying on" } },
    ]);
    // Codex reports one compaction on two channels; a second compact frame would print the chat's "Context compacted"
    // line twice for a single compaction.
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-17" },
        { kind: "compact", trigger: "auto" },
        { kind: "delta", text: "carrying on" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("the post-compaction heads-up is dropped on the error channel too, rather than failing the turn", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-18" },
        { type: "error", message: COMPACTED_HEADS_UP },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "carrying on" } },
    ]);
    // Codex has serialized this heads-up as an error before; reddening a turn that only compacted is the bug that
    // mapping it to a compact frame was meant to fix, and dropping it fixes without doubling the notice.
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-18" },
        { kind: "delta", text: "carrying on" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a plan turn survives a compaction and still proposes its plan", async () => {
    // A compaction marking the phase errored would drop a plan the turn really produced; plan turns are exactly the
    // long kind that hits the threshold.
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-14" },
            { type: "item.completed", item: { id: "compact-1", type: "context_compaction" } },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => ({
        approve: true,
    }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-14" },
        { kind: "compact", trigger: "auto" },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route." },
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
        // An approved plan moves the conversation out of planning, as the Claude loop's approval does.
        { kind: "mode", mode: "bypassPermissions" },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    expect(calls).toHaveLength(2);
});

test("a compaction doesn't stand in for the real failure when the turn then dies", async () => {
    // The compact frame never touches surfacedError, so a turn that compacts and then really dies still gets the exit
    // wrapper's message.
    const runner: CodexRunner = async function* () {
        yield { type: "item.completed", item: { id: "compact-1", type: "context_compaction" } } as CodexEvent;
        throw new Error(PROCESS_EXIT);
    };
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "compact", trigger: "auto" },
        { kind: "error", message: PROCESS_EXIT },
        { kind: "done" },
    ]);
});

test("turn failures and thrown runners become error events followed by done", async () => {
    const failing = fakeCodexRunner([{ type: "turn.failed", error: { message: "usage limit reached" } }]);
    // Coded rate_limit for a muted reset countdown; auto-continue waits for the reset, not a hammering retry.
    expect(await collect(createTestAgent(failing.runner), request)).toEqual([
        { kind: "error", code: "rate_limit", message: "usage limit reached" },
        { kind: "done" },
    ]);

    const throwing: CodexRunner = async function* () {
        yield { type: "thread.started", thread_id: "thr-4" } as CodexEvent;
        throw new Error("app-server connection failed");
    };
    expect(await collect(createTestAgent(throwing), request)).toEqual([
        { kind: "session", sessionId: "thr-4" },
        { kind: "error", message: "app-server connection failed" },
        { kind: "done" },
    ]);
});

// Codex's own sentence once its compaction cannot make room, and the Responses API's under it: either way the thread is
// past the window, so the daemon re-runs the turn in a fresh one instead of resuming this into the same wall.
test("a thread past the model's window is coded context-overflow, in Codex's words or the API's", async () => {
    const codex = "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
    const own = fakeCodexRunner([{ type: "turn.failed", error: { message: codex } }]);
    expect(await collect(createTestAgent(own.runner), request)).toEqual([
        { kind: "error", code: "context-overflow", message: codex },
        { kind: "done" },
    ]);

    const api = "Your input exceeds the context window of this model. Please adjust your input and try again.";
    const upstream = fakeCodexRunner([{ type: "error", message: api }]);
    expect(await collect(createTestAgent(upstream.runner), request)).toEqual([
        { kind: "error", code: "context-overflow", message: api },
        { kind: "done" },
    ]);
});

// Verbatim from the daemon log, minus the wrapping: the translator's answer when its Go transport never reached the
// model, which wears the same words as a plan that excludes it.
const DNS_STALL =
    "unexpected status 503 Service Unavailable: auth_unavailable: no auth available (providers=codex, model=gpt-6-astra; " +
    'last upstream error: Post "https://chatgpt.com/backend-api/codex/responses": utls: dial upstream: dial tcp: ' +
    "lookup chatgpt.com on 127.0.0.11:53: read udp 127.0.0.1:36274->127.0.0.11:53: i/o timeout), url: http://127.0.0.1:8789/v1/responses";

test("one failure reported on both of Codex's channels reddens the turn once", async () => {
    // app-server publishes a failure on its error notification AND in turn/completed; two frames would post the same
    // sentence to the chat twice, which is what the user sees.
    const failure = "Your workspace is out of credits.";
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-8" },
        { type: "error", message: failure },
        { type: "turn.failed", error: { message: failure } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-8" },
        { kind: "error", message: failure },
        { kind: "done" },
    ]);
});

test("a turn the translator never got to the model is re-run, not surfaced", async () => {
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-a" },
            { type: "error", message: DNS_STALL },
            { type: "turn.failed", error: { message: DNS_STALL } },
        ],
        [
            { type: "thread.started", thread_id: "thr-b" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Added the route." } },
        ],
    );
    jest.useFakeTimers();
    try {
        const events = collect(createTestAgent(runner), request);
        await advanceTimersByTimeAsync(3_000);
        expect(await events).toEqual([
            { kind: "session", sessionId: "thr-a" },
            { kind: "provider_retry", attempt: 1, maxAttempts: 3, nextAttemptAt: expect.any(Number) as number },
            { kind: "session", sessionId: "thr-b" },
            { kind: "delta", text: "Added the route." },
            { kind: "text_end" },
            { kind: "done" },
        ]);
    } finally {
        jest.useRealTimers();
    }
    expect(calls).toHaveLength(2);
});

test("the same failure after the turn did work is surfaced, since a re-run would repeat it", async () => {
    // The prompt is re-sent on a retry, so a transport failure only earns one while the attempt has nothing to lose.
    const { runner, calls } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-c" },
        {
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "1 passed", exit_code: 0, status: "completed" },
        },
        { type: "turn.failed", error: { message: DNS_STALL } },
    ]);
    const events = await collect(createTestAgent(runner), request);
    expect(events.at(-2)).toEqual({ kind: "error", message: DNS_STALL });
    expect(calls).toHaveLength(1);
});

test("a transport failure that outlasts the retries is surfaced in the end", async () => {
    const { runner, calls } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-d" },
        { type: "turn.failed", error: { message: DNS_STALL } },
    ]);
    jest.useFakeTimers();
    try {
        const events = collect(createTestAgent(runner), request);
        await advanceTimersByTimeAsync(11_000);
        expect((await events).filter((event) => event.kind === "error")).toEqual([{ kind: "error", message: DNS_STALL }]);
    } finally {
        jest.useRealTimers();
    }
    // Three attempts: the two waits are the cap, and the third failure is the turn's answer.
    expect(calls).toHaveLength(3);
});

test("a turn stopped before its retry's backoff begins ends there, without waiting the backoff out", async () => {
    const controller = new AbortController();
    const { runner: failing, calls } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-e" },
        { type: "turn.failed", error: { message: DNS_STALL } },
    ]);
    // Stopped while the attempt that earns the retry runs, so the signal is already aborted when the wait would start.
    const runner: CodexRunner = async function* (turn) {
        controller.abort();
        yield* failing(turn);
    };
    jest.useFakeTimers();
    try {
        let ended = false;
        const events = collect(createTestAgent(runner), { ...request, signal: controller.signal }).finally(() => {
            ended = true;
        });
        // The clock never moves: a wait the stop had already ended must not hold the turn open.
        await advanceTimersByTimeAsync(0);
        expect(ended).toBe(true);
        expect((await events).filter((event) => event.kind === "provider_retry")).toHaveLength(1);
    } finally {
        jest.useRealTimers();
    }
    expect(calls).toHaveLength(1);
});

test("a streamed error survives the app-server process-exit throw", async () => {
    // The generic process-exit wrapper must not overwrite an actionable message Codex already streamed.
    const runner: CodexRunner = async function* () {
        yield { type: "thread.started", thread_id: "thr-5" } as CodexEvent;
        yield { type: "turn.failed", error: { message: "Your workspace is out of credits." } } as CodexEvent;
        throw new Error(PROCESS_EXIT);
    };
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-5" },
        { kind: "error", message: "Your workspace is out of credits." },
        { kind: "done" },
    ]);
});

test("the thread's skills become the composer's command list", async () => {
    const { runner } = fakeCodexRunner([
        { type: "commands", skills: [{ name: "release", description: "Cut a release", path: "/work/.codex/skills/release" }] },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "commands", items: [{ name: "release", description: "Cut a release" }] },
        { kind: "done" },
    ]);
});

test("a Codex question becomes the same card the ask tool raises, and the picks travel back on the request", async () => {
    const answered: Record<string, readonly string[]>[] = [];
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-q" },
        {
            type: "user_input.requested",
            questions: [
                {
                    id: "q1",
                    header: "Auth",
                    question: "Which sign-in should the route accept?",
                    options: [
                        { label: "Google", description: "SSO through the connected account" },
                        { label: "Email", description: "A code sent to the address" },
                    ],
                    secret: false,
                },
            ],
            respond: (answers) => answered.push(answers),
        },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Using Google." } },
    ]);

    const events = await collect(createTestAgent(runner), request, undefined, () => ({
        answers: { "Which sign-in should the route accept?": ["Google"] },
    }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-q" },
        {
            kind: "question",
            requestId: expect.any(String) as string,
            questions: [
                {
                    question: "Which sign-in should the route accept?",
                    header: "Auth",
                    // Codex publishes no multi-select flag, so every card it raises is single-pick.
                    multiSelect: false,
                    options: [
                        { label: "Google", description: "SSO through the connected account" },
                        { label: "Email", description: "A code sent to the address" },
                    ],
                },
            ],
        },
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: {
                kind: "question",
                requestId: expect.any(String) as string,
                answers: { "Which sign-in should the route accept?": ["Google"] },
            },
        },
        { kind: "delta", text: "Using Google." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    expect(answered).toEqual([{ q1: ["Google"] }]);
});

test("a dismissed question tells Codex so rather than leaving it holding the request", async () => {
    const answered: Record<string, readonly string[]>[] = [];
    const { runner } = fakeCodexRunner([
        {
            type: "user_input.requested",
            questions: [{ id: "q1", header: "Auth", question: "Which sign-in?", options: [], secret: false }],
            respond: (answers) => answered.push(answers),
        },
    ]);

    await collect(createTestAgent(runner), request, undefined, () => ({ cancelled: true }));

    expect(answered).toEqual([{ q1: ["The user dismissed the questions without answering and stopped the turn."] }]);
});

// A question an unattended turn asks waits for the owner like any other card, so the tool is on for every turn.
test("an unattended turn can still ask: its question waits for the owner", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, unattended: true } });
    // Turned on by name, not by omission: Codex registers the tool when the table is absent, and names it here.
    expect(calls[0]!.config).toMatchObject({ "tools.experimental_request_user_input.enabled": true });
});

test("a question for a secret is refused without a card, because a card's answers are recorded", async () => {
    const answered: Record<string, readonly string[]>[] = [];
    const { runner } = fakeCodexRunner([
        {
            type: "user_input.requested",
            questions: [{ id: "key", header: "Key", question: "Paste the API key", options: [], secret: true }],
            respond: (answers) => answered.push(answers),
        },
    ]);

    const events = await collect(createTestAgent(runner), request);

    expect(events.some((event) => event.kind === "question")).toBe(false);
    expect(answered[0]?.["key"]?.[0]).toContain("does not collect secrets");
});

test("an anchored turn's app-server is born in the turn's mount namespace", async () => {
    const plan = { worktree: `${HISTORY_ROOT}/worktrees/c1/work`, root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/c1`, fence: undefined };
    const { runner, calls } = fakeCodexRunner([]);

    await collect(createTestAgent(runner), {
        ...request,
        spec: { ...request.spec, isolation: { plan, anchor: { pid: 4321, cwd: WORKSPACE_ROOT, plan, dispose: () => {} } } },
    });

    expect(calls[0]!.namespace).toEqual({ pid: 4321, cwd: WORKSPACE_ROOT });
});

test("Codex's local descriptors preserve the same namespace capability across planning and execution", async () => {
    const plan = { worktree: `${HISTORY_ROOT}/worktrees/c1/work`, root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/c1`, fence: undefined };
    const namespace = registerMountEntry(62003);
    const anchor = { pid: namespace.pid, cwd: WORKSPACE_ROOT, plan, namespace, dispose: () => {} };
    const { runner, calls } = fakeCodexRunner([{ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } }], []);
    try {
        await collect(
            createTestAgent(runner),
            { ...request, spec: { ...request.spec, isolation: { plan, anchor } }, policy: { ...request.policy, permissionMode: "plan" } },
            () => ({ approve: true }),
        );
        expect(calls).toHaveLength(2);
        expect(calls[0]?.namespace).toEqual({ pid: 62003, cwd: WORKSPACE_ROOT, namespace });
        expect(calls[0]?.namespace?.namespace).toBe(namespace);
        expect(calls[1]?.namespace).toBe(calls[0]?.namespace);
        expect(calls[1]?.namespace?.namespace).toBe(namespace);
    } finally {
        forgetNamespaceEntry(namespace);
    }
});

test("an isolated turn the container could not anchor carries no namespace and runs cwd'd as before", async () => {
    const plan = { worktree: `${HISTORY_ROOT}/worktrees/c1/work`, root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/c1`, fence: undefined };
    const { runner, calls } = fakeCodexRunner([]);

    await collect(createTestAgent(runner), { ...request, spec: { ...request.spec, cwd: plan.worktree, isolation: { plan } } });

    expect(calls[0]!.namespace).toBeUndefined();
    expect(calls[0]!.options.workingDirectory).toBe(plan.worktree);
});

test("each turn gets a steering channel, and one typed while the plan is read reaches the execution phase", async () => {
    const queue = new SteeringQueue();
    const { runner, calls, steered } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-s" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );

    await collect(
        createTestAgent(runner),
        { ...request, spec: { ...request.spec, steering: queue }, policy: { ...request.policy, permissionMode: "plan" as const } },
        () => {
            // Typed while the plan card is up; that phase's channel already closed, so it belongs to the next one.
            queue.push("use fastify");
            return { approve: true };
        },
    );

    expect(calls).toHaveLength(2);
    expect(steered).toEqual([[], ["use fastify"]]);
});

// Owner's safety policy on Codex, over item/commandExecution/requestApproval. The judge is a stub throughout; approval
// events are hand-built since what's checked is the verdict on respond.
const approvalTurn = (command: string, respond: (allow: boolean) => void): CodexRunner =>
    async function* () {
        yield { type: "thread.started", thread_id: "thr-a" };
        yield { type: "command_approval.requested", command, respond };
        yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } };
    };

// Stub judge: returns one constant verdict for whatever it's shown.
const judging =
    (decision: "allow" | "ask" | "refuse"): TurnHooks["judge"] =>
    async () => ({ decision, sentence: "It does the thing." });

test("a refused command declines rather than cancelling the turn", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("git push --force origin main", (allow) => decisions.push(allow)));

    const events = await collect(agent, { ...request, hooks: { ...request.hooks, judge: judging("refuse") } });

    expect(decisions).toEqual([false]);
    // The turn carried on past the refusal: the agent hears no and picks something else.
    expect(events.some((event) => event.kind === "done")).toBe(true);
});

test("an unclassified command is approved, so an ordinary turn is untouched", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("pnpm test", (allow) => decisions.push(allow)));

    await collect(agent, { ...request, hooks: { ...request.hooks, judge: judging("refuse") } });

    expect(decisions).toEqual([true]);
});

// Approvals fire on every turn, since triage and the hard rule are facts about the command, not the owner's config;
// most round-trips resolve to yes without the judge ever being asked.
test("approvals are requested on every turn, configured or not", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    const agent = createTestAgent(runner);

    await collect(agent, request);
    expect(calls[0]!.options.approvalPolicy).toBe("untrusted");

    await collect(agent, { ...request, hooks: { ...request.hooks, judge: judging("ask") } });
    expect(calls[1]!.options.approvalPolicy).toBe("untrusted");

    // A turn woken by a stranger is gated too, which was already true under the taint floor.
    await collect(agent, { ...request, policy: { ...request.policy, outsideWake: "discord" } });
    expect(calls[2]!.options.approvalPolicy).toBe("untrusted");
});

// An ask parks the Codex turn on the same permission card a Bash hook raises; app-server blocks on the request, so
// nothing else arrives while it's read.
test("an asked command raises a permission card and approves it when the user allows", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("rm -rf build", (allow) => decisions.push(allow)));
    const events: AgentEvent[] = [];

    for await (const event of agent({ ...request, hooks: { ...request.hooks, judge: judging("ask") } })) {
        events.push(event);
        if (event.kind === "permission") {
            setTimeout(() => cards.resolve({ kind: "permission", requestId: event.requestId, decision: "once" }), 0);
        }
    }

    const card = events.find((event) => event.kind === "permission");
    // Reaches the card as a program, marked where the classifier fired, same shape as the Claude path's card.
    expect(card).toMatchObject({
        title: "It does the thing.",
        program: { text: "rm -rf build", language: "bash", spans: [{ start: 0, end: 12 }] },
    });
    expect(events.some((event) => event.kind === "resolved")).toBe(true);
    expect(decisions).toEqual([true]);
});

test("declining the card refuses the command", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("rm -rf build", (allow) => decisions.push(allow)));

    for await (const event of agent({ ...request, hooks: { ...request.hooks, judge: judging("ask") } })) {
        if (event.kind === "permission") {
            setTimeout(() => cards.resolve({ kind: "permission", requestId: event.requestId, decision: "deny" }), 0);
        }
    }

    expect(decisions).toEqual([false]);
});

test("an unattended turn raises the card and waits for it, rather than refusing", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("rm -rf build", (allow) => decisions.push(allow)));
    const events: AgentEvent[] = [];

    for await (const event of agent({ ...request, policy: { ...request.policy, unattended: true }, hooks: { ...request.hooks, judge: judging("ask") } })) {
        events.push(event);
        if (event.kind === "permission") {
            setTimeout(() => cards.resolve({ kind: "permission", requestId: event.requestId, decision: "once" }), 0);
        }
    }

    expect(events.some((event) => event.kind === "permission")).toBe(true);
    expect(decisions).toEqual([true]);
});

test("Codex cached input is subtracted and uncached input is clamped at zero", async () => {
    const { runner } = fakeCodexRunner([
        {
            type: "turn.completed",
            usage: {
                input_tokens: 2,
                cached_input_tokens: 3,
                cache_write_input_tokens: 1,
                output_tokens: 5,
                reasoning_output_tokens: 0,
            },
        },
    ]);
    const events = await collect(createTestAgent(runner), request);
    expect(events).toEqual([{ kind: "usage", inputTokens: 0, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 1 }, { kind: "done" }]);
});

test("delegated cache tokens remain separate in the turn's usage and count toward subagent totals", async () => {
    const { runner } = fakeCodexRunner([
        { type: "subagent.usage", parent: "spawn-1", input: 100, output: 50, cacheRead: 300, cacheCreation: 100 },
        {
            type: "turn.completed",
            usage: { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 0 },
        },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "subagent_update", id: "spawn-1", tokens: 550 },
        { kind: "usage", inputTokens: 106, outputTokens: 55, cacheReadTokens: 303, cacheCreationTokens: 101 },
        { kind: "done" },
    ]);
});

test("a steering follow-up counts each subagent's cumulative spend once", async () => {
    const usage = { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 0 };
    const { runner } = fakeCodexRunner([
        { type: "subagent.usage", parent: "spawn-1", input: 100, output: 50, cacheRead: 300, cacheCreation: 100 },
        { type: "turn.completed", usage },
        { type: "turn.completed", usage },
    ]);
    const events = await collect(createTestAgent(runner), request);
    expect(events.filter((event) => event.kind === "usage")).toEqual([
        { kind: "usage", inputTokens: 106, outputTokens: 55, cacheReadTokens: 303, cacheCreationTokens: 101 },
        { kind: "usage", inputTokens: 6, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 1 },
    ]);
});

// Narrows a frame list to one kind, for the tests that read a field off it.
const isKind =
    <K extends AgentEvent["kind"]>(kind: K) =>
    (event: AgentEvent): event is Extract<AgentEvent, { kind: K }> =>
        event.kind === kind;

// Codex types its failures (codexErrorInfo); the type decides the code before any sentence is read, so a provider that
// fell over is counted by the outage breaker and resumed once it is back, whatever words this release chose.
describe("a typed failure is coded by its type", () => {
    const failing = (info: CodexFailureInfo) => fakeCodexRunner([{ type: "turn.failed", error: { message: "The model could not be reached.", info } }]);
    const codeOf = async (info: CodexFailureInfo): Promise<string | undefined> =>
        (await collect(createTestAgent(failing(info).runner), request)).find(isKind("error"))?.code;

    test("a transport or capacity failure is an outage", async () => {
        expect(await codeOf({ kind: "httpConnectionFailed", httpStatus: 502 })).toBe("provider-outage");
        expect(await codeOf({ kind: "responseStreamDisconnected" })).toBe("provider-outage");
        expect(await codeOf({ kind: "serverOverloaded" })).toBe("provider-outage");
    });

    test("a spent allowance or a 429 is a rate limit, a full window a context overflow", async () => {
        expect(await codeOf({ kind: "usageLimitExceeded" })).toBe("rate_limit");
        expect(await codeOf({ kind: "responseStreamConnectionFailed", httpStatus: 429 })).toBe("rate_limit");
        expect(await codeOf({ kind: "contextWindowExceeded" })).toBe("context-overflow");
    });

    // A 4xx behind a broken connection is the provider refusing, which a re-run would only repeat.
    test("a refusal the type cannot place is left to the sentence rules", async () => {
        expect(await codeOf({ kind: "httpConnectionFailed", httpStatus: 401 })).toBeUndefined();
        expect(await codeOf({ kind: "badRequest" })).toBeUndefined();
    });

    test("the error channel is typed the same way", async () => {
        const { runner } = fakeCodexRunner([{ type: "error", message: "The model could not be reached.", willRetry: false, info: { kind: "internalServerError" } }]);
        expect(await collect(createTestAgent(runner), request)).toEqual([
            { kind: "error", code: "provider-outage", message: "The model could not be reached." },
            { kind: "done" },
        ]);
    });
});

// willRetry, not the sentence, says Codex is retrying; a notice with no counters still counts its own attempts.
test("a retry Codex marks willRetry is a wait whatever it says, with the status behind it", async () => {
    const { runner } = fakeCodexRunner([
        // As codex-cli 0.162 words it when the network is down: no counters, so the old sentence match failed the turn.
        { type: "error", message: "Reconnecting... waiting for network", willRetry: true, info: { kind: "responseStreamDisconnected", httpStatus: 503 } },
        { type: "error", message: "Reconnecting... waiting for network", willRetry: true },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "back" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "provider_retry", attempt: 1, status: 503 },
        { kind: "provider_retry", attempt: 2 },
        { kind: "delta", text: "back" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a failed or interrupted turn still reports what it spent, before its failure", async () => {
    const usage = { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 0 };
    const { runner } = fakeCodexRunner([{ type: "turn.failed", error: { message: "Codex turn was interrupted" }, usage }]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "usage", inputTokens: 6, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 1 },
        { kind: "error", message: "Codex turn was interrupted" },
        { kind: "done" },
    ]);
});

test("prose and reasoning stream as Codex writes them, and their completion adds only what was not yet said", async () => {
    const { runner } = fakeCodexRunner([
        { type: "item.delta", item_id: "r1", channel: "reasoning", text: "Reading", part: 0 },
        { type: "item.delta", item_id: "r1", channel: "reasoning", text: " the route.", part: 0 },
        { type: "item.delta", item_id: "r1", channel: "reasoning", text: "Then the test.", part: 1 },
        { type: "item.completed", item: { id: "r1", type: "reasoning", text: "Reading the route.\nThen the test." } },
        { type: "item.delta", item_id: "m1", channel: "message", text: "Added " },
        { type: "item.delta", item_id: "m1", channel: "message", text: "the route" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Added the route." } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "thinking", text: "Reading" },
        { kind: "thinking", text: " the route." },
        // A new summary part is a new paragraph, as the completed item joins them.
        { kind: "thinking", text: "\nThen the test." },
        { kind: "delta", text: "Added " },
        { kind: "delta", text: "the route" },
        { kind: "delta", text: "." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a planning phase holds its prose back while its reasoning still streams", async () => {
    const { runner } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-p" },
            { type: "item.delta", item_id: "r1", channel: "reasoning", text: "Thinking." },
            { type: "item.delta", item_id: "m1", channel: "message", text: "Plan: add" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [],
    );
    const events = await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => ({ approve: false }));
    expect(events.slice(0, 3)).toMatchObject([
        { kind: "session", sessionId: "thr-p" },
        { kind: "thinking", text: "Thinking." },
        { kind: "plan", text: "Plan: add the route." },
    ]);
    expect(events.some((event) => event.kind === "delta")).toBe(false);
});

// The update frame replaces the card's content, so each one carries the output so far, and not one per line of it.
test("a running command's output streams onto its card, at most a few times a second", async () => {
    const { runner } = fakeCodexRunner([
        { type: "item.started", item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "", status: "in_progress" } },
        { type: "item.delta", item_id: "c1", channel: "output", text: "1 passed\n" },
        { type: "item.delta", item_id: "c1", channel: "output", text: "2 passed\n" },
        { type: "item.completed", item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "1 passed\n2 passed\n", exit_code: 0, status: "completed" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
        { kind: "tool_call_update", id: "c1", content: [{ type: "text", text: "1 passed\n" }] },
        { kind: "tool_call_update", id: "c1", status: "completed", content: [{ type: "text", text: "1 passed\n2 passed\n" }] },
        { kind: "done" },
    ]);
});

test("a patch's card opens with each file's change and settles as it lands", async () => {
    const changes = [
        { path: `${WORKSPACE_ROOT}/src/new.ts`, kind: "add" as const, diff: "export const ping = 1;\n" },
        { path: "src/app.ts", kind: "update" as const, diff: "@@ -1 +1 @@\n-old\n+new\n" },
        { path: "src/gone.ts", kind: "delete" as const, diff: "bye\n" },
    ];
    const { runner } = fakeCodexRunner([
        { type: "item.started", item: { id: "f1", type: "file_change", changes, status: "in_progress" } },
        { type: "item.completed", item: { id: "f1", type: "file_change", changes, status: "completed" } },
    ]);
    const content: ToolCallContent[] = [
        { type: "diff", path: "src/new.ts", newText: "export const ping = 1;\n" },
        { type: "text", text: "src/app.ts\n@@ -1 +1 @@\n-old\n+new\n" },
        { type: "diff", path: "src/gone.ts", oldText: "bye\n", newText: "" },
    ];
    expect(await collect(createTestAgent(runner), request)).toEqual([
        {
            kind: "tool_call",
            id: "f1",
            name: "Edit",
            category: "edit",
            status: "in_progress",
            target: `add ${WORKSPACE_ROOT}/src/new.ts, update src/app.ts, delete src/gone.ts`,
            locations: [{ path: "src/new.ts" }, { path: "src/app.ts" }, { path: "src/gone.ts" }],
            content,
        },
        { kind: "tool_call_update", id: "f1", status: "completed", content },
        { kind: "done" },
    ]);
});

test("the thread's context fill becomes the context frame", async () => {
    const { runner } = fakeCodexRunner([{ type: "context", tokens: 41_000, window: 272_000 }]);
    expect(await collect(createTestAgent(runner), request)).toEqual([{ kind: "context_usage", tokens: 41_000, contextWindow: 272_000 }, { kind: "done" }]);
});

test("a turn Codex moved to another model names the model that served it, and says why", async () => {
    const { runner } = fakeCodexRunner([{ type: "model.rerouted", from: "gpt-6-sol", to: "gpt-5.5", reason: "highRiskCyberActivity" }]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "init", model: "gpt-5.5" },
        { kind: "error", code: "codex-advisory", message: "Codex moved this turn from gpt-6-sol to gpt-5.5 because it read as high-risk security work." },
        { kind: "done" },
    ]);
});

test("a turn that asked for fast speed asks Codex for its fast tier; any other asks for none", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner), { ...request, spec: { ...request.spec, model: "gpt-5.5", fast: true } });
    await collect(createTestAgent(runner), { ...request, spec: { ...request.spec, model: "gpt-5.5" } });
    expect(calls[0]!.options.serviceTier).toBe("priority");
    expect(calls[1]!.options).not.toHaveProperty("serviceTier");
});

test("the owner's instructions ride thread/start's own fields", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner), { ...request, spec: { ...request.spec, systemPrompt: "You write release notes.", systemAppend: "Be brief." } });
    expect(calls[0]!.instructions).toEqual({ base: "You write release notes.", developer: "Be brief." });
    expect(calls[0]!.config).not.toHaveProperty("developer_instructions");
    expect(calls[0]!.config).not.toHaveProperty("model_instructions_file");
});

// With a model to name, the planning turn runs in Codex's own plan mode: no preamble, and the plan card shows the plan it
// proposed rather than whatever message came last.
test("a plan turn plans in Codex's own plan mode and executes back in its default mode", async () => {
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-n" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "I read the router first." } },
            { type: "item.completed", item: { id: "p1", type: "plan", text: "1. Add the route.\n2. Test it." } },
            { type: "item.completed", item: { id: "m2", type: "agent_message", text: "Say the word." } },
        ],
        [{ type: "item.completed", item: { id: "m3", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(
        createTestAgent(runner),
        { ...request, spec: { ...request.spec, model: "gpt-5.5" }, policy: { ...request.policy, permissionMode: "plan" as const } },
        () => ({ approve: true }),
    );
    expect(events.filter(isKind("delta")).map((event) => event.text)).toEqual([
        "I read the router first.",
        "Say the word.",
        "Done.",
    ]);
    expect(events.find((event) => event.kind === "plan")).toMatchObject({ text: "1. Add the route.\n2. Test it." });
    expect(calls[0]!.prompt).toBe("add a /ping route");
    expect(calls[0]!.options).toMatchObject({ sandboxMode: "read-only", collaborationMode: "plan" });
    expect(calls[1]!.options).toMatchObject({ sandboxMode: "danger-full-access", collaborationMode: "default" });
});

describe("approvals by permission mode", () => {
    type Answer = readonly [allow: boolean, remember: boolean | undefined];
    const twoCommands = (answers: Answer[]): CodexRunner =>
        async function* () {
            yield { type: "command_approval.requested", command: "pnpm build", respond: (allow, remember) => answers.push([allow, remember]) };
            yield { type: "command_approval.requested", command: "pnpm build", respond: (allow, remember) => answers.push([allow, remember]) };
        };
    const answering = async (runner: CodexRunner, turnRequest: AgentRequest<CodexCredential>, decision: "once" | "always" | "deny"): Promise<AgentEvent[]> => {
        const events: AgentEvent[] = [];
        for await (const event of createTestAgent(runner)(turnRequest)) {
            events.push(event);
            if (event.kind === "permission") {
                setTimeout(() => cards.resolve({ kind: "permission", requestId: event.requestId, decision }), 0);
            }
        }
        return events;
    };
    const manual = { ...request, policy: { ...request.policy, permissionMode: "default" as const }, hooks: { ...request.hooks, judge: judging("allow") } };

    test("default mode puts each command the gate lets through to a person", async () => {
        const answers: Answer[] = [];
        const events = await answering(twoCommands(answers), manual, "once");
        expect(events.filter((event) => event.kind === "permission")).toHaveLength(2);
        expect(events.find((event) => event.kind === "permission")).toMatchObject({
            toolName: "Bash",
            program: { text: "pnpm build", language: "bash" },
            alwaysLabel: "Don't ask again for Run command",
        });
        expect(answers).toEqual([
            [true, false],
            [true, false],
        ]);
    });

    test("an always is remembered for the run and for Codex's thread", async () => {
        const answers: Answer[] = [];
        const events = await answering(twoCommands(answers), manual, "always");
        expect(events.filter((event) => event.kind === "permission")).toHaveLength(1);
        expect(answers).toEqual([
            [true, true],
            [true, true],
        ]);
    });

    test("a no declines the command", async () => {
        const answers: Answer[] = [];
        await answering(twoCommands(answers), manual, "deny");
        expect(answers[0]).toEqual([false, false]);
    });

    test("every other mode asks nobody", async () => {
        const answers: Answer[] = [];
        const events = await answering(twoCommands(answers), { ...manual, policy: { ...request.policy, permissionMode: "bypassPermissions" as const } }, "deny");
        expect(events.some((event) => event.kind === "permission")).toBe(false);
        expect(answers).toEqual([
            [true, undefined],
            [true, undefined],
        ]);
    });

    test("a patch is put to the person by the files it touches", async () => {
        const answers: Answer[] = [];
        const runner: CodexRunner = async function* () {
            yield { type: "item.started", item: { id: "f1", type: "file_change", changes: [{ path: "src/app.ts", kind: "update" }], status: "in_progress" } };
            yield { type: "file_change_approval.requested", item_id: "f1", respond: (allow, remember) => answers.push([allow, remember]) };
        };
        const events = await answering(runner, manual, "once");
        expect(events.find((event) => event.kind === "permission")).toMatchObject({ toolName: "Edit", title: "Apply this patch to src/app.ts?", path: "src/app.ts" });
        expect(answers).toEqual([[true, false]]);
    });

    test("a planning phase declines a patch and keeps only the network half of a widening", async () => {
        const patches: boolean[] = [];
        const grants: string[] = [];
        const { runner } = fakeCodexRunner(
            [
                { type: "file_change_approval.requested", item_id: "f1", respond: (allow) => patches.push(allow) },
                { type: "permissions_approval.requested", writes: true, respond: (grant) => grants.push(grant) },
                { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: build it." } },
            ],
            [{ type: "permissions_approval.requested", writes: true, respond: (grant) => grants.push(grant) }],
        );
        await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => ({ approve: true }));
        expect(patches).toEqual([false]);
        // Planning keeps the network; the approved execution runs as everything-allowed and takes the whole ask.
        expect(grants).toEqual(["network", "all"]);
    });
});

// Codex's question request carries up to three questions; they share one card, and a secret among them is refused
// without reaching it.
test("every question of a request rides one card, and each answer goes back under its own id", async () => {
    const answered: Record<string, readonly string[]>[] = [];
    const { runner } = fakeCodexRunner([
        {
            type: "user_input.requested",
            questions: [
                { id: "q1", header: "Auth", question: "Which sign-in?", options: [{ label: "Google", description: "SSO" }], secret: false },
                { id: "q2", header: "Store", question: "Where do sessions live?", options: [], secret: false },
                { id: "q3", header: "Key", question: "Paste the key", options: [], secret: true },
            ],
            respond: (answers) => answered.push(answers),
        },
    ]);
    const events = await collect(createTestAgent(runner), request, undefined, () => ({
        answers: { "Which sign-in?": ["Google"], "Where do sessions live?": ["Redis"] },
    }));
    expect(events.find(isKind("question"))?.questions).toHaveLength(2);
    expect(answered[0]?.["q1"]).toEqual(["Google"]);
    expect(answered[0]?.["q2"]).toEqual(["Redis"]);
    expect(answered[0]?.["q3"]?.[0]).toContain("does not collect secrets");
});

// The turn's per-thread hooks on the door's gate (codex-hooks.ts): a request that mounted the gate carries the relay its
// servers wait on and a `gate` mount among its remote servers.
describe("hooks on the door's gate", () => {
    const GATE_MOUNT = { name: "gate", url: "http://127.0.0.1:8787/mcp/gate", token: "t", timeoutMs: 86_400_000 };
    const gatedRequest = (relay: TurnRelay, overrides: Partial<AgentRequest<CodexCredential>> = {}): AgentRequest<CodexCredential> => ({
        ...request,
        tools: { ...request.tools, remote: [GATE_MOUNT] },
        hooks: { ...request.hooks, relay },
        ...overrides,
    });

    test("every phase writes the hooks onto its thread, waits for the gate to connect, and drops the trust notice", async () => {
        const relay = createTurnRelay();
        const calls: CodexTurn[] = [];
        let key: string | undefined;
        const runner: CodexRunner = async function* (turn) {
            calls.push(turn);
            // The key the gate holds the hooks to while the run is attached.
            key = relay.gateHooks()?.key;
            yield { type: "thread.started", thread_id: "thr-h" };
            yield { type: "warning", message: "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation." };
            yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } };
        };
        const events = await collect(createTestAgent(runner), gatedRequest(relay));

        const config = calls[0]!.config ?? {};
        expect(key).toEqual(expect.any(String));
        expect(JSON.stringify(config["hooks.PreToolUse"])).toContain(`"key":"${key ?? ""}"`);
        // Detached with the run: the gate refuses whatever comes after.
        expect(relay.gateHooks()).toBeUndefined();
        expect(config["bypass_hook_trust"]).toBe(true);
        expect(JSON.stringify(config["hooks.PreToolUse"])).toContain('"server":"gate","tool":"pre_tool_use"');
        expect(JSON.stringify(config["hooks.PostToolUse"])).toContain('"tool":"post_tool_use"');
        expect(JSON.stringify(config["hooks.Stop"])).toContain('"tool":"stop"');
        expect(config["mcp_servers.gate"]).toEqual({ url: GATE_MOUNT.url, http_headers: { Authorization: "Bearer t" }, tool_timeout_sec: 86_400 });
        expect(calls[0]!.requiredMcp).toEqual(["gate"]);
        expect(events.some((event) => event.kind === "error")).toBe(false);
    });

    test("a call that starts with no answer from the gate stops the turn, as does a PreToolUse hook that failed", async () => {
        for (const stray of [
            { type: "item.started", item: { id: "c9", type: "command_execution", command: "cat .env", aggregated_output: "", status: "in_progress" } },
            { type: "hook.failed", event: "preToolUse", id: "c9", message: "MCP server 'gate' is not connected" },
        ] satisfies CodexEvent[]) {
            const relay = createTurnRelay();
            let aborted = false;
            const runner: CodexRunner = async function* (turn) {
                yield { type: "thread.started", thread_id: "thr-h" };
                yield stray;
                aborted = turn.signal.aborted;
                yield { type: "turn.failed", error: { message: "Codex turn was interrupted" } };
            };
            const events = await collect(createTestAgent(runner), gatedRequest(relay));
            expect(aborted).toBe(true);
            expect(events.filter((event) => event.kind === "error").map((event) => (event.kind === "error" ? event.message : ""))).toEqual([UNGATED_CALL]);
        }
    });

    test("an approval for a call the gate allowed is not asked again; one the gate never answered is refused", async () => {
        const relay = createTurnRelay();
        const decisions: [string, boolean][] = [];
        const runner: CodexRunner = async function* () {
            yield { type: "thread.started", thread_id: "thr-h" };
            const hooks = relay.gateHooks();
            await hooks?.settle?.({ tool: "Bash", input: { command: "rm -rf build" }, id: "c1" }, { decision: "allow" }, false);
            yield { type: "item.started", item: { id: "c1", type: "command_execution", command: "rm -rf build", aggregated_output: "", status: "in_progress" } };
            yield { type: "command_approval.requested", command: "rm -rf build", item_id: "c1", respond: (allow) => decisions.push(["c1", allow]) };
            yield { type: "command_approval.requested", command: "rm -rf dist", item_id: "c2", respond: (allow) => decisions.push(["c2", allow]) };
            // A subagent's thread has no gate connected: its ask is judged as it always was.
            yield { type: "command_approval.requested", command: "pnpm test", item_id: "s1", subagent: true, respond: (allow) => decisions.push(["s1", allow]) };
            yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } };
        };
        // A judge that refuses everything: the gate's earlier answer is what lets c1 through.
        await collect(createTestAgent(runner), gatedRequest(relay, { hooks: { ...request.hooks, relay, judge: judging("refuse") } }));
        expect(decisions).toEqual([
            ["c1", true],
            ["c2", false],
            ["s1", true],
        ]);
    });

    test("frames the door's tools push reach the running phase's inbox", async () => {
        const relay = createTurnRelay();
        const { runner, calls } = fakeCodexRunner([{ type: "thread.started", thread_id: "thr-h" }]);
        await collect(createTestAgent(runner), gatedRequest(relay));
        // Detached once the run ends: a push now is buffered by the relay, not delivered to a dead inbox.
        relay.push({ kind: "terminal", session: "agent-x" });
        expect(calls[0]!.frames?.take()).toEqual([]);
    });

    test("a turn held to a tool list does not run where no gate was mounted to hold it", async () => {
        const { runner, calls } = fakeCodexRunner([]);
        const events = await collect(createTestAgent(runner), { ...request, policy: { ...request.policy, allowedTools: ["Read"] } });
        expect(calls).toHaveLength(0);
        expect(events).toEqual([{ kind: "error", message: UNGATED_LIST, own: true }, { kind: "done" }]);
    });

    test("a tool list turns off what no hook sees and cuts each server to its listed tools", async () => {
        const relay = createTurnRelay();
        const { runner, calls } = fakeCodexRunner([]);
        await collect(
            createTestAgent(runner),
            gatedRequest(relay, {
                policy: { ...request.policy, allowedTools: ["Bash(git log:*)", "mcp__browser__browser_snapshot"] },
                tools: { ...request.tools, remote: [GATE_MOUNT, { name: "browser", url: "http://127.0.0.1:8787/mcp/browser" }] },
            }),
        );
        const config = calls[0]!.config ?? {};
        expect(config["web_search"]).toBe("disabled");
        expect(config["features.multi_agent"]).toBe(false);
        expect(config["tools.experimental_request_user_input.enabled"]).toBe(false);
        expect(config["features.shell_tool"]).toBeUndefined();
        expect(config["mcp_servers.browser.enabled_tools"]).toEqual(["browser_snapshot"]);
        expect(config["mcp_servers.gate.enabled_tools"]).toBeUndefined();
    });
});

/* Codex honours the translator's Retry-After, which for a spent allowance is the rest of its window: on 2026-10-13 three
   subagents sat as working for what would have been 3h48m ("retrying sampling request (1/5 in 13734s)"), each holding
   its seat and its parent's wait, after Codex had already said "Reconnecting... 1/5" and gone quiet. */
describe("a rate limit Codex waits out inside the turn", () => {
    const LIMITED: CodexEvent = {
        type: "error",
        message: "Reconnecting... 1/5 (exceeded retry limit, last status: 429 Too Many Requests)",
        willRetry: true,
        info: { kind: "responseStreamDisconnected", httpStatus: 429 },
    };
    // Codex as it behaves: the retry notice, then nothing until the phase is stopped, then the interrupted ending.
    const sleepingRunner = (ends: "interrupted" | "killed") => {
        let stopped = false;
        const runner: CodexRunner = async function* (turn) {
            yield { type: "thread.started", thread_id: "thr-limit" };
            yield LIMITED;
            // A stop sent before Codex next reads its signal (a hand-over decided at once) is still a stop.
            await new Promise<void>((resolve) => {
                if (turn.signal.aborted) {
                    resolve();
                    return;
                }
                turn.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            stopped = true;
            if (ends === "killed") {
                throw new Error("Codex app-server exited (SIGTERM)");
            }
            yield { type: "turn.failed", error: { message: "Codex turn was interrupted" } };
        };
        return { runner, stopped: () => stopped };
    };

    it("hands the wait to the daemon once patience runs out, as a rate limit the turn is held on", async () => {
        const { runner, stopped } = sleepingRunner("interrupted");
        jest.useFakeTimers();
        try {
            const events = collect(createTestAgent(runner), request);
            await advanceTimersByTimeAsync(RATE_LIMIT_PATIENCE_MS - 1_000);
            expect(stopped()).toBe(false);
            await advanceTimersByTimeAsync(1_000);
            expect(await events).toEqual([
                { kind: "session", sessionId: "thr-limit" },
                { kind: "provider_retry", attempt: 1, maxAttempts: 5, status: 429 },
                // Coded, so classify-failure holds it for the reset; the interrupt it caused is not said as a second failure.
                { kind: "error", code: "rate_limit", message: LIMIT_WAIT_HANDED_OVER, own: true },
                { kind: "done" },
            ]);
            expect(stopped()).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    // (2026-10-20) The translator benched the account until the Retry-After it was quoted, four hours off: the turn is
    // handed over as soon as that is read, not after two minutes shown as working.
    it("hands the wait over at once when the allowance's reopening is past patience", async () => {
        const { runner, stopped } = sleepingRunner("interrupted");
        const spent: AgentRequest<CodexCredential> = {
            ...request,
            credential: {
                kind: "codex-endpoint",
                baseUrl: "http://127.0.0.1:8317",
                authToken: "local",
                allowance: { vendor: "openai", capacity: async () => ({ kind: "spent", accounts: 1, reopensAt: Math.floor(Date.now() / 1000) + 4 * 3600 }) },
            },
        };
        jest.useFakeTimers();
        try {
            const events = collect(createTestAgent(runner), spent);
            // A second of the clock, against the two minutes patience would have waited.
            await advanceTimersByTimeAsync(1_000);
            expect(stopped()).toBe(true);
            expect((await events).filter((event) => event.kind === "error")).toEqual([{ kind: "error", code: "rate_limit", message: LIMIT_WAIT_HANDED_OVER, own: true }]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("reads an app-server killed by that interrupt as the same hand-over, not a crash", async () => {
        const { runner } = sleepingRunner("killed");
        jest.useFakeTimers();
        try {
            const events = collect(createTestAgent(runner), request);
            await advanceTimersByTimeAsync(RATE_LIMIT_PATIENCE_MS);
            expect((await events).filter((event) => event.kind === "error")).toEqual([{ kind: "error", code: "rate_limit", message: LIMIT_WAIT_HANDED_OVER, own: true }]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("lets a limit the provider lifts within patience ride, and starts the clock afresh after an answer", async () => {
        const runner: CodexRunner = async function* () {
            yield { type: "thread.started", thread_id: "thr-short" };
            yield LIMITED;
            await sleep(RATE_LIMIT_PATIENCE_MS / 2);
            yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "back" } };
            // A second limit later in the turn is given its own full patience, not what the first one left.
            yield LIMITED;
            await sleep(RATE_LIMIT_PATIENCE_MS - 1_000);
            yield { type: "item.completed", item: { id: "m2", type: "agent_message", text: "done" } };
            yield { type: "turn.completed" };
        };
        jest.useFakeTimers();
        try {
            const events = collect(createTestAgent(runner), request);
            await advanceTimersByTimeAsync(RATE_LIMIT_PATIENCE_MS / 2);
            await advanceTimersByTimeAsync(RATE_LIMIT_PATIENCE_MS - 1_000);
            const seen = await events;
            expect(seen.filter((event) => event.kind === "error")).toEqual([]);
            expect(seen.filter((event) => event.kind === "delta")).toEqual([
                { kind: "delta", text: "back" },
                { kind: "delta", text: "done" },
            ]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("never counts a retry that is no rate limit against patience", async () => {
        const runner: CodexRunner = async function* () {
            yield { type: "error", message: "Reconnecting... waiting for network", willRetry: true, info: { kind: "responseStreamDisconnected", httpStatus: 503 } };
            await sleep(RATE_LIMIT_PATIENCE_MS * 2);
            yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "back" } };
        };
        jest.useFakeTimers();
        try {
            const events = collect(createTestAgent(runner), request);
            await advanceTimersByTimeAsync(RATE_LIMIT_PATIENCE_MS * 2);
            expect((await events).filter((event) => event.kind === "error")).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });
});

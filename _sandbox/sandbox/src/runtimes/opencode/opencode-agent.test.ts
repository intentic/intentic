import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { ClientError, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync, realYield } from "@intentic/testing/bun";
import {
    createOpenCodeAgent,
    createOpenCodeRunner,
    type OpenCodeRunner,
    type OpenCodeTurn,
    type OpenCodeTurnEvent,
    type RaisedFrame,
    sessionFamily,
    type TurnSession,
} from "./opencode-agent.js";
import type { EventOf } from "./opencode-frames.js";
import { type CommandGuard, consultWith, type GuardOutcome, vendorSubject } from "../../guard/command-guard.js";
import { opt } from "../../opt.js";
import type { OpenCodeListener, OpenCodeService, SessionJudge } from "./opencode.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { mcpServersOf, type OpenCodeMcpServer, openCodeMounts } from "./opencode-mcp.js";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { DEFAULT_TURN_TIMEOUTS } from "../decorators/turn-watchdog.js";
import { EXECUTE_PROMPT, PLAN_PREAMBLE } from "../decorators/plan-mode.js";
import { planRevision } from "../../agent/prompt/plan-revision.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";

// The OpenCode 2 turn: the adapter's events-to-frames mapping over a faked runner, and the runner's session setup, event
// reading and cleanup over a faked shared server. Event shapes follow what opencode 2.0.26 sends.

afterEach(() => {
    jest.useRealTimers();
});

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// ---------------------------------------------------------------------------------------------------------------------
// OpenCode 2's events, whole, one builder per type the turn reads.

let serial = 0;
const stamp = () => {
    serial += 1;
    return { id: `evt_${String(serial)}`, created: serial };
};
const durable = <V extends 1 | 2>(aggregateID: string, version: V) => ({ aggregateID, seq: serial, version });

type StructuredError = EventOf<"session.execution.failed">["data"]["error"];
type ToolMetadata = EventOf<"session.tool.progress">["data"]["metadata"];
// A block of text or reasoning: the assistant message it belongs to and its place there.
interface Block {
    readonly message?: string;
    readonly ordinal?: number;
}
// What one model step spent.
interface Spend {
    readonly input: number;
    readonly output: number;
    readonly read?: number;
    readonly write?: number;
    readonly cost: number;
}

const sessionCreated = (sessionID: string, parentID?: string): EventOf<"session.created"> => ({
    ...stamp(),
    type: "session.created",
    durable: durable(sessionID, 1),
    data: { sessionID, projectID: "p1", location: { directory: WORKSPACE_ROOT }, slug: sessionID, version: "2.0.26", ...opt("parentID", parentID) },
});
const started = (sessionID: string): EventOf<"session.execution.started"> => ({
    ...stamp(),
    type: "session.execution.started",
    durable: durable(sessionID, 1),
    data: { sessionID },
});
const succeeded = (sessionID: string): EventOf<"session.execution.succeeded"> => ({
    ...stamp(),
    type: "session.execution.succeeded",
    durable: durable(sessionID, 1),
    data: { sessionID },
});
const failed = (sessionID: string, error: StructuredError): EventOf<"session.execution.failed"> => ({
    ...stamp(),
    type: "session.execution.failed",
    durable: durable(sessionID, 1),
    data: { sessionID, error },
});
const interrupted = (sessionID: string, reason: EventOf<"session.execution.interrupted">["data"]["reason"]): EventOf<"session.execution.interrupted"> => ({
    ...stamp(),
    type: "session.execution.interrupted",
    durable: durable(sessionID, 1),
    data: { sessionID, reason },
});
const textDelta = (sessionID: string, delta: string, block: Block = {}): EventOf<"session.text.delta"> => ({
    ...stamp(),
    type: "session.text.delta",
    data: { sessionID, assistantMessageID: block.message ?? "m1", ordinal: block.ordinal ?? 0, delta },
});
const textEnded = (sessionID: string, text: string, block: Block = {}): EventOf<"session.text.ended"> => ({
    ...stamp(),
    type: "session.text.ended",
    durable: durable(sessionID, 1),
    data: { sessionID, assistantMessageID: block.message ?? "m1", ordinal: block.ordinal ?? 0, text },
});
const reasoningDelta = (sessionID: string, delta: string, block: Block = {}): EventOf<"session.reasoning.delta"> => ({
    ...stamp(),
    type: "session.reasoning.delta",
    data: { sessionID, assistantMessageID: block.message ?? "m1", ordinal: block.ordinal ?? 0, delta },
});
const reasoningEnded = (sessionID: string, text: string, block: Block = {}): EventOf<"session.reasoning.ended"> => ({
    ...stamp(),
    type: "session.reasoning.ended",
    durable: durable(sessionID, 1),
    data: { sessionID, assistantMessageID: block.message ?? "m1", ordinal: block.ordinal ?? 0, text },
});
const toolStarted = (sessionID: string, id: string, name: string): EventOf<"session.tool.input.started"> => ({
    ...stamp(),
    type: "session.tool.input.started",
    durable: durable(sessionID, 1),
    data: { sessionID, assistantMessageID: "m1", id, name },
});
const toolCalled = (sessionID: string, id: string, input: Record<string, unknown>): EventOf<"session.tool.called"> => ({
    ...stamp(),
    type: "session.tool.called",
    durable: durable(sessionID, 1),
    data: { sessionID, assistantMessageID: "m1", id, input, executed: true },
});
const toolProgress = (sessionID: string, id: string, metadata: ToolMetadata): EventOf<"session.tool.progress"> => ({
    ...stamp(),
    type: "session.tool.progress",
    data: { sessionID, assistantMessageID: "m1", id, metadata },
});
const toolSucceeded = (sessionID: string, id: string, text: string, metadata?: ToolMetadata): EventOf<"session.tool.success"> => ({
    ...stamp(),
    type: "session.tool.success",
    durable: durable(sessionID, 2),
    data: { sessionID, assistantMessageID: "m1", id, content: [{ type: "text", text }], ...opt("metadata", metadata), executed: true },
});
const toolFailed = (sessionID: string, id: string, error: StructuredError): EventOf<"session.tool.failed"> => ({
    ...stamp(),
    type: "session.tool.failed",
    durable: durable(sessionID, 2),
    data: { sessionID, assistantMessageID: "m1", id, error, executed: false },
});
const stepEnded = (sessionID: string, spend: Spend): EventOf<"session.step.ended"> => ({
    ...stamp(),
    type: "session.step.ended",
    durable: durable(sessionID, 1),
    data: {
        sessionID,
        assistantMessageID: "m1",
        finish: "stop",
        cost: spend.cost,
        tokens: { input: spend.input, output: spend.output, reasoning: 0, cache: { read: spend.read ?? 0, write: spend.write ?? 0 } },
    },
});
const retryScheduled = (sessionID: string, attempt: number, at: number, error: StructuredError): EventOf<"session.retry.scheduled"> => ({
    ...stamp(),
    type: "session.retry.scheduled",
    durable: durable(sessionID, 1),
    data: { sessionID, assistantMessageID: "m1", attempt, at, error },
});
const userQueued = (sessionID: string, text: string): EventOf<"session.inbox.enqueued"> => ({
    ...stamp(),
    type: "session.inbox.enqueued",
    durable: durable(sessionID, 1),
    data: { sessionID, inboxID: "msg_1", item: { type: "user", payload: { text }, delivery: "steer" } },
});
const shellExited = (id: string): EventOf<"shell.exited"> => ({ ...stamp(), type: "shell.exited", data: { id, exit: 0, status: "exited" } });
const shellDeleted = (id: string): EventOf<"shell.deleted"> => ({ ...stamp(), type: "shell.deleted", data: { id } });

// What the runner says besides OpenCode's own events: the session the turn runs on, and a card its judge raised.
const session = (sessionId: string, created = true): TurnSession => ({ type: "intentic.session", sessionId, created });
const raised = (frame: AgentEvent): RaisedFrame => ({ type: "intentic.frame", frame });

// ---------------------------------------------------------------------------------------------------------------------
// The adapter over a faked runner.

// Yields one canned list per invocation (a plan turn calls it once per phase), capturing each turn.
const fakeRunner = (...turns: (readonly OpenCodeTurnEvent[])[]): { runner: OpenCodeRunner; calls: OpenCodeTurn[] } => {
    const calls: OpenCodeTurn[] = [];
    const runner: OpenCodeRunner = async function* (turn) {
        calls.push(turn);
        yield* turns[Math.min(calls.length - 1, turns.length - 1)] ?? [];
    };
    return { runner, calls };
};

const request: AgentRequest<ContainerCredential> = {
    execution: unstubbed("execution", {}),
    spec: { prompt: "add a /ping route", cwd: WORKSPACE_ROOT },
    policy: {},
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: new AbortController().signal,
};
const planned: AgentRequest<ContainerCredential> = { ...request, policy: { ...request.policy, permissionMode: "plan" } };

// Collects every frame; `onPlan` answers each plan, on a timer since the generator's yield suspends before the plan
// card's wait registers.
const collect = async (
    agent: ReturnType<typeof createOpenCodeAgent>,
    turnRequest: AgentRequest<ContainerCredential>,
    onPlan?: () => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan();
            setTimeout(() => cards.resolve({ kind: "plan", requestId: event.requestId, ...decision }), 0);
        }
    }
    return events;
};
const planIds = (events: readonly AgentEvent[]): string[] => events.flatMap((event) => (event.kind === "plan" ? [event.requestId] : []));

test("a turn maps OpenCode's events onto session, thinking, tool cards, deltas, usage summed per step, and done", async () => {
    const { runner } = fakeRunner([
        session("s1"),
        started("s1"),
        reasoningDelta("s1", "planning the edit"),
        reasoningEnded("s1", "planning the edit"),
        toolStarted("s1", "c1", "shell"),
        toolCalled("s1", "c1", { command: "pnpm test" }),
        toolProgress("s1", "c1", { output: "running" }),
        toolSucceeded("s1", "c1", "1 passed"),
        stepEnded("s1", { input: 1000, output: 200, read: 800, write: 120, cost: 0.25 }),
        textDelta("s1", "Added ", { message: "m2" }),
        textDelta("s1", "the route.", { message: "m2" }),
        textEnded("s1", "Added the route.", { message: "m2" }),
        stepEnded("s1", { input: 300, output: 50, cost: 0.125 }),
        succeeded("s1"),
    ]);

    expect(await collect(createOpenCodeAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "thinking", text: "planning the edit" },
        { kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
        { kind: "tool_call_update", id: "c1", status: "completed", content: [{ type: "text", text: "1 passed" }] },
        { kind: "delta", text: "Added " },
        { kind: "delta", text: "the route." },
        { kind: "usage", inputTokens: 1300, outputTokens: 250, cacheReadTokens: 800, cacheCreationTokens: 120, costUsd: 0.375 },
        { kind: "done" },
    ]);
});

// A resumed session is already the chat's; a block's ending carries its whole text, of which only what its deltas did
// not already stream is new.
test("a resumed turn says no session, and a block that ends with more than its deltas carried sends the rest", async () => {
    const { runner } = fakeRunner([
        session("s1", false),
        textDelta("s1", "Hel"),
        textEnded("s1", "Hello."),
        reasoningEnded("s1", "Quietly reasoned.", { message: "m2" }),
        textEnded("s1", "Second block.", { ordinal: 1 }),
        succeeded("s1"),
    ]);

    expect(await collect(createOpenCodeAgent(runner), request)).toEqual([
        { kind: "delta", text: "Hel" },
        { kind: "delta", text: "lo." },
        { kind: "thinking", text: "Quietly reasoned." },
        { kind: "delta", text: "Second block." },
        { kind: "done" },
    ]);
});

// OpenCode's subagent tool runs a subagent in a child session naming the parent, and tells the call that session's id
// on its progress; the child's own events come on the same stream. Drawn as the Claude loop's are: the subagent on its
// call's card, its calls, thinking, prose and spend under that card, its report as the subagent's summary.
test("a subagent call runs under its card: its session's calls, thinking, prose and spend, then its report", async () => {
    const report = `<subagent sessionID="child-1" state="completed">\nFound 7 reads.\n</subagent>`;
    const { runner } = fakeRunner([
        session("s1"),
        started("s1"),
        toolStarted("s1", "sub-1", "subagent"),
        toolCalled("s1", "sub-1", { agent: "explore", description: "Map the reads", prompt: "Find every read of users." }),
        // Heard before the call names the session, so held until it does.
        sessionCreated("child-1", "s1"),
        started("child-1"),
        textDelta("child-1", "Looking for reads.", { message: "cm1" }),
        toolProgress("s1", "sub-1", { sessionID: "child-1" }),
        toolStarted("child-1", "cc1", "grep"),
        toolCalled("child-1", "cc1", { pattern: "from(users)" }),
        toolSucceeded("child-1", "cc1", "api/a.ts:3"),
        stepEnded("child-1", { input: 900, output: 100, cost: 0.5 }),
        reasoningDelta("child-1", "Seven of them.", { message: "cm2" }),
        textDelta("child-1", "Found 7 reads.", { message: "cm2" }),
        succeeded("child-1"),
        toolSucceeded("s1", "sub-1", report, { sessionID: "child-1" }),
        stepEnded("s1", { input: 1000, output: 200, cost: 0.25 }),
        succeeded("s1"),
    ]);

    expect(await collect(createOpenCodeAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "tool_call", id: "sub-1", name: "Task", category: "other", status: "in_progress" },
        { kind: "subagent", id: "sub-1", subagentKind: "subagent", agentType: "explore", description: "Map the reads" },
        { kind: "delta", text: "Looking for reads.", parentToolUseId: "sub-1" },
        { kind: "tool_call", id: "cc1", name: "Grep", category: "search", status: "in_progress", target: "from(users)", parentToolUseId: "sub-1" },
        { kind: "subagent_update", id: "sub-1", toolUses: 1, lastTool: "Grep" },
        { kind: "tool_call_update", id: "cc1", status: "completed", content: [{ type: "text", text: "api/a.ts:3" }] },
        { kind: "subagent_update", id: "sub-1", tokens: 1000 },
        { kind: "thinking", text: "Seven of them.", parentToolUseId: "sub-1" },
        { kind: "delta", text: "Found 7 reads.", parentToolUseId: "sub-1" },
        { kind: "tool_call_update", id: "sub-1", status: "completed", content: [{ type: "text", text: report }] },
        { kind: "subagent_update", id: "sub-1", status: "completed", summary: "Found 7 reads." },
        // The subagent's spend is the turn's: the account paid for it.
        { kind: "usage", inputTokens: 1900, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.75 },
        { kind: "done" },
    ]);
});

test("a subagent call that fails ends its subagent failed, with OpenCode's own words", async () => {
    const { runner } = fakeRunner([
        session("s1"),
        toolStarted("s1", "sub-2", "subagent"),
        toolCalled("s1", "sub-2", { agent: "general", description: "Port the job", prompt: "Port it." }),
        toolFailed("s1", "sub-2", { type: "tool.execution", message: "Subagent failed: out of credits" }),
        succeeded("s1"),
    ]);

    expect(await collect(createOpenCodeAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "tool_call", id: "sub-2", name: "Task", category: "other", status: "in_progress" },
        { kind: "subagent", id: "sub-2", subagentKind: "subagent", agentType: "general", description: "Port the job" },
        { kind: "tool_call_update", id: "sub-2", status: "failed", content: [{ type: "text", text: "Subagent failed: out of credits" }] },
        { kind: "subagent_update", id: "sub-2", status: "failed", error: "Subagent failed: out of credits" },
        { kind: "done" },
    ]);
});

// A card opens on a call's whole input; a call whose input never arrived is first seen at its failure, as one whole card.
test("a failing tool first seen at its failure arrives as one whole failed tool_call, and one already open is updated", async () => {
    const { runner } = fakeRunner([
        toolStarted("s1", "c1", "shell"),
        toolFailed("s1", "c1", { type: "tool.input-invalid", message: "command: expected a string" }),
        toolStarted("s1", "c2", "shell"),
        toolCalled("s1", "c2", { command: "git push --force" }),
        toolFailed("s1", "c2", { type: "permission.rejected", message: "The owner's rulebook refused this." }),
        succeeded("s1"),
    ]);

    expect(await collect(createOpenCodeAgent(runner), request)).toEqual([
        { kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "failed", content: [{ type: "text", text: "command: expected a string" }] },
        { kind: "tool_call", id: "c2", name: "Bash", category: "execute", status: "in_progress", target: "git push --force" },
        { kind: "tool_call_update", id: "c2", status: "failed", content: [{ type: "text", text: "The owner's rulebook refused this." }] },
        { kind: "done" },
    ]);
});

test("a build turn resumes the session on the xai provider, passes the model, and names a non-picture attachment in the prompt", async () => {
    const pdf = `${WORKSPACE_ROOT}/.intentic/records/artifacts/attachments/a/report.pdf`;
    const { runner, calls } = fakeRunner([]);
    await collect(createOpenCodeAgent(runner), {
        ...request,
        spec: { ...request.spec, conversationId: "chat-1", sessionId: "s9", model: "grok-4.20-0309-non-reasoning", attachments: [pdf] },
    });

    expect(calls.map(({ gate, ...turn }) => ({ gated: gate !== undefined, ...turn }))).toEqual([
        {
            gated: true,
            prompt: `add a /ping route\n\nThe user attached these files: read them as needed:\n- ${pdf}`,
            sessionId: "s9",
            cwd: WORKSPACE_ROOT,
            model: "grok-4.20-0309-non-reasoning",
            provider: "xai",
            agent: "build",
            mounts: openCodeMounts("chat-1", []),
            signal: request.signal,
        },
    ]);
});

test("a sealed request runs as one build message carrying its own system prompt, not a turn's standing instructions", async () => {
    const { runner, calls } = fakeRunner([]);
    await collect(createOpenCodeAgent(runner, OPENCODE_GEMINI_PROVIDER), {
        ...request,
        spec: {
            ...request.spec,
            conversationId: "chat-1",
            model: "gemini-3-flash",
            systemPromptMode: "custom",
            systemPrompt: "Answer exactly.",
            systemAppend: "## Delegating",
        },
        policy: { sealed: true },
    });

    expect(calls.map(({ gate, ...turn }) => ({ gated: gate !== undefined, ...turn }))).toEqual([
        {
            gated: true,
            prompt: "add a /ping route",
            cwd: WORKSPACE_ROOT,
            model: "gemini-3-flash",
            provider: OPENCODE_GEMINI_PROVIDER,
            agent: "build",
            mounts: openCodeMounts("chat-1", []),
            system: "Answer exactly.",
            sealed: true,
            signal: request.signal,
        },
    ]);
});

// Image attachments are in opencode-agent.integration.test.ts, which needs real files on disk.

test("a plan turn proposes read-only on the plan agent, then executes on build after approval", async () => {
    const { runner, calls } = fakeRunner(
        [session("s2"), textDelta("s2", "Plan: add the route, then test."), succeeded("s2")],
        [session("s2", false), textDelta("s2", "Done.", { message: "m2" }), succeeded("s2")],
    );
    const events = await collect(createOpenCodeAgent(runner), planned, () => ({ approve: true }));
    const [requestId = "no plan"] = planIds(events);

    expect(events).toEqual([
        { kind: "session", sessionId: "s2" },
        { kind: "plan", requestId, text: "Plan: add the route, then test." },
        { kind: "resolved", requestId, reply: { kind: "plan", requestId, approve: true } },
        { kind: "delta", text: "Done." },
        { kind: "done" },
    ]);
    expect(calls.map((call) => ({ agent: call.agent, prompt: call.prompt, sessionId: call.sessionId }))).toEqual([
        { agent: "plan", prompt: `${PLAN_PREAMBLE}add a /ping route`, sessionId: undefined },
        { agent: "build", prompt: EXECUTE_PROMPT, sessionId: "s2" },
    ]);
});

test("a rejected plan loops another read-only planning turn carrying the feedback", async () => {
    const { runner, calls } = fakeRunner(
        [session("s3"), textDelta("s3", "Plan v1"), succeeded("s3")],
        [session("s3", false), textDelta("s3", "Plan v2", { message: "m2" }), succeeded("s3")],
        [session("s3", false), textDelta("s3", "Executed.", { message: "m3" }), succeeded("s3")],
    );
    let planCount = 0;
    const events = await collect(createOpenCodeAgent(runner), planned, () => {
        planCount += 1;
        return planCount === 1 ? { approve: false, feedback: "use fastify" } : { approve: true };
    });

    expect(events.flatMap((event) => (event.kind === "plan" ? [event.text] : []))).toEqual(["Plan v1", "Plan v2"]);
    expect(events.slice(-2)).toEqual([{ kind: "delta", text: "Executed." }, { kind: "done" }]);
    expect(calls.map((call) => ({ agent: call.agent, prompt: call.prompt, sessionId: call.sessionId }))).toEqual([
        { agent: "plan", prompt: `${PLAN_PREAMBLE}add a /ping route`, sessionId: undefined },
        { agent: "plan", prompt: planRevision("use fastify"), sessionId: "s3" },
        { agent: "build", prompt: EXECUTE_PROMPT, sessionId: "s3" },
    ]);
});

// OpenCode 2 hands the user's own prompt back on the session's inbox, never as assistant text; what else could pollute a
// plan is the planner's reasoning and the prose of a subagent it sent to look around, which stream as their own frames.
test("a plan captures only the assistant's own text, never the user's prompt, its reasoning or its subagent's prose", async () => {
    const { runner } = fakeRunner(
        [
            session("s5"),
            userQueued("s5", `${PLAN_PREAMBLE}add a /ping route`),
            started("s5"),
            reasoningDelta("s5", "Weighing two routes."),
            toolStarted("s5", "sub-1", "subagent"),
            toolCalled("s5", "sub-1", { agent: "explore", description: "Look around", prompt: "Find the router." }),
            sessionCreated("child-1", "s5"),
            toolProgress("s5", "sub-1", { sessionID: "child-1" }),
            textDelta("child-1", "The router is in src/app.ts.", { message: "cm1" }),
            toolSucceeded("s5", "sub-1", "The router is in src/app.ts.", { sessionID: "child-1" }),
            textDelta("s5", "Plan: add the route.", { message: "m2" }),
            succeeded("s5"),
        ],
        [session("s5", false), succeeded("s5")],
    );
    const events = await collect(createOpenCodeAgent(runner), planned, () => ({ approve: true }));
    const [requestId = "no plan"] = planIds(events);

    expect(events.filter((event) => event.kind === "plan" || event.kind === "delta" || event.kind === "thinking")).toEqual([
        { kind: "thinking", text: "Weighing two routes." },
        { kind: "delta", text: "The router is in src/app.ts.", parentToolUseId: "sub-1" },
        { kind: "plan", requestId, text: "Plan: add the route." },
    ]);
});

test("a plan turn that fails after partial plan text emits the error and no plan frame", async () => {
    const { runner } = fakeRunner([
        session("s6"),
        textDelta("s6", "Plan: first, "),
        failed("s6", { type: "provider.payment-required", message: "Payment Required", status: 402 }),
    ]);

    expect(await collect(createOpenCodeAgent(runner), planned, () => ({ approve: true }))).toEqual([
        { kind: "session", sessionId: "s6" },
        { kind: "error", message: "Payment Required" },
        { kind: "done" },
    ]);
});

test("a failed execution and a thrown runner become error events followed by done", async () => {
    const failing = fakeRunner([failed("s1", { type: "provider.auth", message: "xai auth rejected", status: 401 })]);
    expect(await collect(createOpenCodeAgent(failing.runner), request)).toEqual([{ kind: "error", message: "xai auth rejected" }, { kind: "done" }]);

    const throwing: OpenCodeRunner = async function* () {
        yield session("s4");
        throw new Error("opencode server blew up");
    };
    expect(await collect(createOpenCodeAgent(throwing), request)).toEqual([
        { kind: "session", sessionId: "s4" },
        { kind: "error", message: "opencode server blew up" },
        { kind: "done" },
    ]);
});

// The coding reads OpenCode's sentence, whatever structured type the failure came with.
const failureFrames = (message: string, provider?: string, model?: string): Promise<AgentEvent[]> =>
    collect(createOpenCodeAgent(fakeRunner([failed("s1", { type: "provider.error", message })]).runner, provider), {
        ...request,
        spec: { ...request.spec, ...opt("model", model) },
    });

test("a spent allowance is coded rate_limit, whatever wording the provider refuses in", async () => {
    // Google's own wording, as the translator relays it once its account fleet is exhausted.
    const google = "429 RESOURCE_EXHAUSTED: You exceeded your current quota for gemini models";
    expect(await failureFrames(google)).toEqual([{ kind: "error", code: "rate_limit", message: google }, { kind: "done" }]);
    // Bare rate-limit wording, reached only after OpenCode's own in-turn retries are spent.
    const bare = "Rate limit exceeded, please try again later";
    expect(await failureFrames(bare)).toEqual([{ kind: "error", code: "rate_limit", message: bare }, { kind: "done" }]);
    // An ordinary failure stays uncoded.
    expect(await failureFrames("connection reset")).toEqual([{ kind: "error", message: "connection reset" }, { kind: "done" }]);
    // A parameter this sandbox never sent, refused upstream: an outage rather than a bad model pick, since "on this model"
    // would otherwise cost a pinned model that was not at fault.
    const unsent = "400 prompt_cache_retention is not supported on this model";
    expect(await failureFrames(unsent)).toEqual([
        {
            kind: "error",
            code: "provider-outage",
            message: `${unsent} This parameter was not sent by intentic. Usually clears on retry; work so far is kept.`,
        },
        { kind: "done" },
    ]);
});

// OpenCode compacts an overflowing session itself; what reaches the turn is an overflow it could not clear, which the
// daemon re-runs in a fresh session instead of resuming this one into the same wall.
test("a session past the model's window is coded context-overflow, in the provider's words", async () => {
    // As opencode 2.0.26 relays it, typed `provider.invalid-request`.
    const openai = "This model's maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens.";
    expect(await failureFrames(openai)).toEqual([{ kind: "error", code: "context-overflow", message: openai }, { kind: "done" }]);
    const xai = "This model's maximum prompt length is 131072 but the request contains 145312 tokens.";
    expect(await failureFrames(xai)).toEqual([{ kind: "error", code: "context-overflow", message: xai }, { kind: "done" }]);
});

test("a model OpenCode or xAI will not run is coded grok-model-invalid, so the client reloads the catalog", async () => {
    // OpenCode's own sentence for a model it cannot route at all.
    expect(await failureFrames("Model unavailable: xai/grok-retired")).toEqual([
        { kind: "error", code: "grok-model-invalid", message: "Model unavailable: xai/grok-retired" },
        { kind: "done" },
    ]);
    const stale = "Model not found: xai/grok-code-fast-1. Did you mean: grok-4.20-0309-reasoning?";
    expect(await failureFrames(stale)).toEqual([{ kind: "error", code: "grok-model-invalid", message: stale }, { kind: "done" }]);
});

test("Google's NOT_FOUND on a Google turn is coded model-unavailable and names the refused model", async () => {
    const refused: AgentEvent = {
        kind: "error",
        code: "model-unavailable",
        message:
            `Google refused claude-opus-5-5-high for this sandbox's Google accounts ("Requested entity was not found."): the translator lists it, ` +
            "but Google does not offer it to them. Nothing here can retry past that: pick another model for this chat (claude-opus-5-5-high is off " +
            "the list until the plan covers it).",
    };
    expect(await failureFrames("Requested entity was not found.", OPENCODE_GEMINI_PROVIDER, "claude-opus-5-5-high")).toEqual([refused, { kind: "done" }]);

    // The same sentence thrown rather than sent as an event is read the same way.
    const throwing: OpenCodeRunner = async function* () {
        yield session("s2");
        throw new Error("Requested entity was not found.");
    };
    expect(
        await collect(createOpenCodeAgent(throwing, OPENCODE_GEMINI_PROVIDER), { ...request, spec: { ...request.spec, model: "claude-opus-5-5-high" } }),
    ).toEqual([{ kind: "session", sessionId: "s2" }, refused, { kind: "done" }]);

    // Grok never says this sentence for a model, so its turns keep the error as it came.
    expect(await failureFrames("Requested entity was not found.", undefined, "grok-4")).toEqual([
        { kind: "error", message: "Requested entity was not found." },
        { kind: "done" },
    ]);
});

test("an in-turn retry surfaces as provider_retry, naming a rate limit by its status or its words", async () => {
    const at = 1_791_493_700_000;
    const { runner } = fakeRunner([
        session("s1"),
        retryScheduled("s1", 2, at, { type: "provider.rate-limit", message: "Too busy, slow down", status: 429 }),
        retryScheduled("s1", 3, at, { type: "provider.error", message: "429 RESOURCE_EXHAUSTED: quota exceeded" }),
        retryScheduled("s1", 4, at, { type: "provider.transport", message: "socket hang up" }),
        succeeded("s1"),
    ]);

    expect(await collect(createOpenCodeAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "provider_retry", attempt: 2, nextAttemptAt: at, status: 429 },
        { kind: "provider_retry", attempt: 3, nextAttemptAt: at, status: 429 },
        { kind: "provider_retry", attempt: 4, nextAttemptAt: at },
        { kind: "done" },
    ]);
});

// A transport failure names neither what was unreachable nor why; the next turn boots the local server afresh.
test("a server the turn could not reach is said as the local OpenCode server, restarted for the next turn", async () => {
    const unreachable = (error: Error): OpenCodeRunner =>
        async function* () {
            yield session("s1");
            throw error;
        };
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:4096");

    expect(await collect(createOpenCodeAgent(unreachable(new ClientError("Transport", { cause: refused }))), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        {
            kind: "error",
            message: "The local OpenCode server that runs Grok turns could not be reached (connect ECONNREFUSED 127.0.0.1:4096). Send again: it is restarted for the next turn.",
        },
        { kind: "done" },
    ]);
    expect(await collect(createOpenCodeAgent(unreachable(new TypeError("fetch failed")), OPENCODE_GEMINI_PROVIDER), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "error", message: "The local OpenCode server that runs Google turns could not be reached. Send again: it is restarted for the next turn." },
        { kind: "done" },
    ]);
});

// Both phases of a plan carry the same instructions: propose-then-execute must not drop them for the second message.
test("a planned turn carries the same standing instructions into its execute phase", async () => {
    const { runner, calls } = fakeRunner([session("s9"), textDelta("s9", "Plan."), succeeded("s9")], [session("s9", false), succeeded("s9")]);
    await collect(createOpenCodeAgent(runner), { ...planned, spec: { ...planned.spec, systemAppend: "House rules: be brief." } }, () => ({ approve: true }));

    expect(calls.map((call) => ({ agent: call.agent, system: call.system }))).toEqual([
        { agent: "plan", system: "House rules: be brief." },
        { agent: "build", system: "House rules: be brief." },
    ]);
});

test("a card raised mid-turn reaches the chat in order with the session's own frames", async () => {
    const card: AgentEvent = {
        kind: "permission",
        requestId: "card-2",
        toolName: "Bash",
        title: "This command would push to main",
        displayName: "Run command",
    };
    const { runner } = fakeRunner([
        session("s1"),
        raised(card),
        raised({ kind: "resolved", requestId: "card-2" }),
        textDelta("s1", "Pushed."),
        succeeded("s1"),
    ]);

    expect(await collect(createOpenCodeAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        card,
        { kind: "resolved", requestId: "card-2" },
        { kind: "delta", text: "Pushed." },
        { kind: "done" },
    ]);
});

// The turn hands its runner the same remote list Codex takes, under its conversation's names, and a call to one of them
// reads as the MCP call it is rather than as the key OpenCode spells it with.
test("an OpenCode turn mounts the turn's remote servers, and a call to one reads as that server's tool", async () => {
    const web = { name: "web", url: "http://127.0.0.1:7000/mcp/web", token: "turn-bearer" };
    const mounts = openCodeMounts("chat-1", [web]);
    const { runner, calls } = fakeRunner([
        session("s1"),
        toolStarted("s1", "c1", `${mounts.prefix}web_browser_navigate`),
        toolCalled("s1", "c1", { url: "https://example.com" }),
        succeeded("s1"),
    ]);
    const events = await collect(createOpenCodeAgent(runner), { ...request, spec: { ...request.spec, conversationId: "chat-1" }, tools: { remote: [web] } });

    expect(calls.map((call) => call.mounts)).toEqual([mounts]);
    expect(events).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "tool_call", id: "c1", name: "Browser navigate", category: "other", status: "in_progress", target: "https://example.com" },
        { kind: "done" },
    ]);
});

// OpenCode can move on from an ask nobody answered (a refused sibling ask stops the session), so the turn's end settles
// any card it left, rather than leaving it up with nobody waiting on the answer.
test("a card still open when the turn ends is settled with it", async () => {
    let consulted: Promise<GuardOutcome> | undefined;
    const runner: OpenCodeRunner = async function* (turn) {
        if (turn.gate === undefined) {
            throw new Error("the adapter hands every turn its gate");
        }
        consulted = consultWith(turn.gate, "git push --force origin main", vendorSubject("Bash"), () => {});
        yield session("s1");
        yield succeeded("s1");
    };
    await collect(createOpenCodeAgent(runner), {
        ...request,
        policy: { judging: "on", rulebook: "approval" },
        hooks: { cards, judge: async () => ({ decision: "ask", sentence: "Rewrites the shared history." }) },
    });

    expect(await consulted).toEqual({ allow: false, reason: "The turn ended before you answered." });
});

// ---------------------------------------------------------------------------------------------------------------------
// The family a turn reads: its own session, its subagents' sessions, and the background shells they start.

test("a turn's session family takes in its subagents' sessions, gates them as its own, and lets them go together", () => {
    const judge: SessionJudge = { gate: unstubbed<CommandGuard>("gate", {}), push: () => {}, hold: () => () => {} };
    const registered: [string, SessionJudge][] = [];
    const released: string[] = [];
    const family = sessionFamily("s1", judge, {
        register: (member, judged) => void registered.push([member, judged]),
        release: (member) => void released.push(member),
    });

    expect([
        family.whose(started("s1")),
        family.whose(sessionCreated("child-1", "s1")),
        family.whose(textDelta("child-1", "Looking.")),
        family.whose(sessionCreated("grandchild", "child-1")),
        family.whose(sessionCreated("stranger", "elsewhere")),
        family.whose(started("stranger")),
    ]).toEqual(["own", "subagent", "subagent", "subagent", undefined, undefined]);
    family.release();
    expect({ registered, released }).toEqual({
        registered: [
            ["s1", judge],
            ["child-1", judge],
            ["grandchild", judge],
        ],
        released: ["s1", "child-1", "grandchild"],
    });
});

// A background shell's events name no session; it is the family's because one of its calls said it started it.
test("a turn's session family follows the background shells its sessions start, and only those", () => {
    const released: string[] = [];
    const family = sessionFamily("s1", undefined, { register: () => {}, release: (member) => void released.push(member) });
    family.whose(sessionCreated("child-1", "s1"));

    expect([
        family.whose(toolProgress("child-1", "c1", { shellID: "sh1" })),
        family.whose(toolProgress("stranger", "c9", { shellID: "sh9" })),
        family.whose(shellExited("sh9")),
    ]).toEqual(["subagent", undefined, undefined]);
    expect([...family.shells()]).toEqual(["sh1"]);
    // A shell ends once: its exit is the family's, and a later deletion of it no longer is.
    expect([family.whose(shellExited("sh1")), family.whose(shellDeleted("sh1"))]).toEqual(["shell", undefined]);
    expect([...family.shells()]).toEqual([]);
    // With no judge nothing was registered, and releasing lets go of every member all the same.
    family.release();
    expect(released).toEqual(["s1", "child-1"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The runner over a faked shared server.

type SessionApi = OpenCodeClient["session"];
type EntryApi = SessionApi["instructions"]["entry"];

// What the server says as each prompt arrives, by prompt: its events, or an Error where its stream is lost.
type Reply = readonly (OpenCodeEvent | Error)[];

interface FakeOptions {
    readonly replies?: readonly Reply[];
    // What the server says when the turn interrupts its session.
    readonly onInterrupt?: Reply;
    // Steps that fail, with the error each fails with.
    readonly fails?: Partial<Record<"create" | "put" | "removeEntry" | "mount" | "prompt", Error>>;
    // How the turn's servers are let go; at once by default.
    readonly unmount?: () => Promise<void>;
    // Runs as a prompt reaches the server, before the server takes it.
    readonly beforePrompt?: () => void;
}

// One shared `opencode serve`: every call the turn makes, in order and with its input, and the one stream every lease
// hears, driven by the test. Its sessions are always created as `s1`.
const fakeOpenCode = (options: FakeOptions = {}) => {
    const log: string[] = [];
    const leases = { selections: [] as Parameters<OpenCodeService["acquire"]>[0][], active: 0, released: 0 };
    const calls = {
        create: [] as Parameters<SessionApi["create"]>[0][],
        update: [] as Parameters<SessionApi["update"]>[0][],
        switchAgent: [] as Parameters<SessionApi["switchAgent"]>[0][],
        switchModel: [] as Parameters<SessionApi["switchModel"]>[0][],
        put: [] as Parameters<EntryApi["put"]>[0][],
        removeEntry: [] as Parameters<EntryApi["remove"]>[0][],
        prompt: [] as Parameters<SessionApi["prompt"]>[0][],
        interrupt: [] as Parameters<SessionApi["interrupt"]>[0][],
        remove: [] as Parameters<SessionApi["remove"]>[0][],
        removeShell: [] as Parameters<OpenCodeClient["shell"]["remove"]>[0][],
        mount: [] as { readonly directory: string; readonly servers: readonly OpenCodeMcpServer[] }[],
        recorded: [] as string[][],
    };
    const judges = new Map<string, SessionJudge>();
    let listener: OpenCodeListener | undefined;
    const step = (name: string, failing?: keyof NonNullable<FakeOptions["fails"]>): void => {
        log.push(name);
        const error = failing === undefined ? undefined : options.fails?.[failing];
        if (error !== undefined) {
            throw error;
        }
    };
    const emit = (...items: (OpenCodeEvent | Error)[]): void => {
        if (listener === undefined) {
            throw new Error("nothing is listening to the server");
        }
        for (const item of items) {
            if (item instanceof Error) {
                listener.lost(item);
            } else {
                listener.event(item);
            }
        }
    };
    const entry = unstubbed<EntryApi>("client.session.instructions.entry", {
        put: async (input) => {
            calls.put.push(input);
            step("put", "put");
        },
        remove: async (input) => {
            calls.removeEntry.push(input);
            step("removeEntry", "removeEntry");
        },
    });
    const client = unstubbed<OpenCodeClient>("client", {
        session: unstubbed<SessionApi>("client.session", {
            create: async (input) => {
                calls.create.push(input);
                step("create", "create");
                return {
                    id: "s1",
                    projectID: "p1",
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    time: { created: 0, updated: 0 },
                    location: { directory: input?.location?.directory ?? WORKSPACE_ROOT },
                };
            },
            update: async (input) => {
                calls.update.push(input);
                step("update");
            },
            switchAgent: async (input) => {
                calls.switchAgent.push(input);
                step("switchAgent");
            },
            switchModel: async (input) => {
                calls.switchModel.push(input);
                step("switchModel");
            },
            prompt: async (input) => {
                options.beforePrompt?.();
                calls.prompt.push(input);
                step("prompt", "prompt");
                emit(...(options.replies?.[calls.prompt.length - 1] ?? []));
                return {
                    id: `msg_${String(calls.prompt.length)}`,
                    sessionID: input.sessionID,
                    time: { created: 0 },
                    type: "user",
                    payload: { text: input.text },
                    delivery: "queue",
                };
            },
            interrupt: async (input) => {
                calls.interrupt.push(input);
                step("interrupt");
                emit(...(options.onInterrupt ?? []));
                return { interrupted: true };
            },
            remove: async (input) => {
                calls.remove.push(input);
                step("remove");
            },
            instructions: unstubbed<SessionApi["instructions"]>("client.session.instructions", { entry }),
        }),
        shell: unstubbed<OpenCodeClient["shell"]>("client.shell", {
            remove: async (input) => {
                calls.removeShell.push(input);
                step("removeShell");
            },
        }),
    });
    const openCode = unstubbed<OpenCodeService>("openCode", {
        acquire: async (model) => {
            log.push("acquire");
            leases.selections.push(model);
            leases.active += 1;
            return {
                client,
                listen: (heard) => {
                    log.push("listen");
                    listener = heard;
                    return () => {
                        log.push("unlisten");
                        listener = undefined;
                    };
                },
                release: () => {
                    log.push("release");
                    leases.active -= 1;
                    leases.released += 1;
                },
            };
        },
        mount: async (directory, servers) => {
            calls.mount.push({ directory, servers });
            step("mount", "mount");
            return async () => {
                log.push("unmount");
                await options.unmount?.();
            };
        },
        recordModels: async (ids) => void calls.recorded.push(ids),
        judges: {
            register: (member, judge) => void judges.set(member, judge),
            release: (member) => void judges.delete(member),
        },
    });
    return { openCode, log, leases, calls, judges, emit, listening: (): boolean => listener !== undefined };
};

const runnerTurn: OpenCodeTurn = { prompt: "hi", cwd: WORKSPACE_ROOT, agent: "build", signal: new AbortController().signal };
// What every session is told about other conversations' servers when its turn mounts none of its own.
const NO_OTHERS = [{ action: "intentic_*", resource: "*", effect: "deny" }] as const;

const drainInto = async (events: AsyncIterable<OpenCodeTurnEvent>, seen: OpenCodeTurnEvent[]): Promise<void> => {
    for await (const event of events) {
        seen.push(event);
    }
};
const drain = async (events: AsyncIterable<OpenCodeTurnEvent>): Promise<OpenCodeTurnEvent[]> => {
    const seen: OpenCodeTurnEvent[] = [];
    await drainInto(events, seen);
    return seen;
};
// What a piece of work failed with, or a sentence saying it did not.
const failureOf = async (work: Promise<unknown>): Promise<string> => {
    try {
        await work;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return "it did not fail";
};

test("a new turn creates its session where it runs, listens before it prompts, ends on its own success, and keeps the session to resume", async () => {
    const worktree = `${HISTORY_ROOT}/worktrees/wise-condor/repo`;
    const own = [started("s1"), textDelta("s1", "Hi.")];
    const end = succeeded("s1");
    const fake = fakeOpenCode({ replies: [[...own, started("someone-else"), textDelta("someone-else", "Not this turn's."), end]] });

    expect(await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, cwd: worktree }))).toEqual([session("s1", true), ...own, end]);
    expect(fake.log).toEqual(["acquire", "create", "listen", "mount", "prompt", "unlisten", "unmount", "release"]);
    expect(fake.calls.create).toEqual([{ location: { directory: worktree }, title: "intentic conversation", agent: "build", permissions: NO_OTHERS }]);
    expect(fake.calls.mount).toEqual([{ directory: worktree, servers: [] }]);
    expect(fake.calls.prompt).toEqual([{ sessionID: "s1", text: "hi" }]);
    expect(fake.leases).toEqual({ selections: [{ providerID: "xai" }], active: 0, released: 1 });
});

test("a runner lets its subagents' sessions through, not a stranger's, and ends only on its own session's ending", async () => {
    const family = [started("s1"), sessionCreated("child-1", "s1"), started("child-1"), textDelta("child-1", "Looking.")];
    const stranger = [sessionCreated("stranger", "elsewhere"), textDelta("stranger", "Not this turn's.")];
    const endings = [succeeded("child-1"), succeeded("s1")];
    const fake = fakeOpenCode({ replies: [[...family, ...stranger, ...endings]] });

    expect(await drain(createOpenCodeRunner(fake.openCode)(runnerTurn))).toEqual([session("s1", true), ...family, ...endings]);
});

// A session keeps its rules, agent and model; each message sets the ones it runs with, and clears the instructions an
// earlier message left (a session that never had them is no failure).
test("a resumed session is set up for this message without creating one, and its old instructions are cleared", async () => {
    const reply = [started("s9"), succeeded("s9")];
    const fake = fakeOpenCode({ replies: [reply], fails: { removeEntry: new Error("no such entry") } });

    expect(await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, sessionId: "s9", model: "grok-4" }))).toEqual([
        session("s9", false),
        ...reply,
    ]);
    expect(fake.log).toEqual([
        "acquire",
        "update",
        "switchAgent",
        "switchModel",
        "removeEntry",
        "listen",
        "mount",
        "prompt",
        "unlisten",
        "unmount",
        "release",
    ]);
    expect(fake.calls.update).toEqual([{ sessionID: "s9", permissions: NO_OTHERS }]);
    expect(fake.calls.switchAgent).toEqual([{ sessionID: "s9", agent: "build" }]);
    expect(fake.calls.switchModel).toEqual([{ sessionID: "s9", model: { providerID: "xai", id: "grok-4" } }]);
    expect(fake.calls.removeEntry).toEqual([{ sessionID: "s9", key: "intentic" }]);
    expect(fake.calls.prompt).toEqual([{ sessionID: "s9", text: "hi" }]);
    expect(fake.leases).toEqual({ selections: [{ providerID: "xai", modelID: "grok-4" }], active: 0, released: 1 });
});

test("the turn's standing instructions go into the session's own instruction entry", async () => {
    const fake = fakeOpenCode({ replies: [[succeeded("s1")]] });
    await collect(createOpenCodeAgent(createOpenCodeRunner(fake.openCode)), { ...request, spec: { ...request.spec, systemAppend: "House rules: be brief." } });

    expect(fake.calls.put).toEqual([{ sessionID: "s1", key: "intentic", value: "House rules: be brief." }]);
    expect(fake.log).toEqual(["acquire", "create", "put", "listen", "mount", "prompt", "unlisten", "unmount", "release"]);
});

// An empty instruction entry is not the same session as none; OpenCode's own prompt should stand.
test("nothing to say sets no instruction entry on a new session", async () => {
    const fake = fakeOpenCode({ replies: [[succeeded("s1")]] });
    await collect(createOpenCodeAgent(createOpenCodeRunner(fake.openCode)), request);

    expect({ put: fake.calls.put, removeEntry: fake.calls.removeEntry }).toEqual({ put: [], removeEntry: [] });
});

// A helper's request (agent-request.ts `policy.sealed`): every tool denied, OpenCode's own included, its system prompt
// the session's instructions, and its session removed once it answered, since nothing resumes it.
test("a sealed request asks with every tool denied, mounts nothing, and leaves no session behind", async () => {
    const fake = fakeOpenCode({ replies: [[started("s1"), textDelta("s1", "42"), succeeded("s1")]] });
    const mounts = openCodeMounts("chat-1", [{ name: "web", url: "http://127.0.0.1:7000/mcp/web" }]);
    await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, system: "Answer exactly.", sealed: true, mounts }));

    expect(fake.calls.create).toEqual([
        {
            location: { directory: WORKSPACE_ROOT },
            title: "intentic conversation",
            agent: "build",
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
    ]);
    expect(fake.calls.put).toEqual([{ sessionID: "s1", key: "intentic", value: "Answer exactly." }]);
    expect(fake.calls.mount).toEqual([{ directory: WORKSPACE_ROOT, servers: [] }]);
    expect(fake.calls.remove).toEqual([{ sessionID: "s1" }]);
    expect(fake.log.slice(-4)).toEqual(["unlisten", "unmount", "remove", "release"]);
});

// Grok and Gemini reach the same remote MCP servers Codex does: the runner mounts them in the turn's directory, and the
// session's own rules show it its own conversation's servers and deny it every other conversation's.
test("a runner mounts the turn's servers where it runs, shows its session only those, and lets them go", async () => {
    const fake = fakeOpenCode({ replies: [[succeeded("s1")]] });
    const mounts = openCodeMounts("chat-1", [{ name: "web", url: "http://127.0.0.1:7000/mcp/web", token: "turn-bearer" }]);
    await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, mounts }));

    expect(fake.calls.mount).toEqual([{ directory: WORKSPACE_ROOT, servers: mcpServersOf(mounts) }]);
    expect(fake.calls.create.map((input) => input?.permissions)).toEqual([
        [
            { action: "intentic_*", resource: "*", effect: "deny" },
            { action: `${mounts.prefix}*`, resource: "*", effect: "allow" },
        ],
    ]);
    expect(fake.log).toEqual(["acquire", "create", "listen", "mount", "prompt", "unlisten", "unmount", "release"]);
});

test("an ungated Google turn leases its exact requested model and releases it on completion", async () => {
    const fake = fakeOpenCode({ replies: [[started("s1"), succeeded("s1")]] });
    const active: number[] = [];
    for await (const event of createOpenCodeRunner(fake.openCode)({ ...runnerTurn, provider: OPENCODE_GEMINI_PROVIDER, model: "claude-opus-5-5-high" })) {
        void event;
        active.push(fake.leases.active);
    }

    expect(active).toEqual([1, 1, 1]);
    expect(fake.leases).toEqual({ selections: [{ providerID: OPENCODE_GEMINI_PROVIDER, modelID: "claude-opus-5-5-high" }], active: 0, released: 1 });
    expect(fake.calls.create.map((input) => input?.model)).toEqual([{ providerID: OPENCODE_GEMINI_PROVIDER, id: "claude-opus-5-5-high" }]);
});

// A step that fails before the turn's loop starts still lets go of everything the turn took up to there.
test.each<{ readonly stage: "create" | "put" | "mount" | "prompt"; readonly log: string[] }>([
    { stage: "create", log: ["acquire", "create", "release"] },
    { stage: "put", log: ["acquire", "create", "put", "release"] },
    { stage: "mount", log: ["acquire", "create", "put", "listen", "mount", "unlisten", "release"] },
    { stage: "prompt", log: ["acquire", "create", "put", "listen", "mount", "prompt", "unlisten", "unmount", "release"] },
])("a turn whose $stage fails lets go of its servers, its sessions' judges and its runtime", async ({ stage, log }) => {
    const fake = fakeOpenCode({ fails: { [stage]: new Error(`${stage} failed`) } });
    const gate = unstubbed<CommandGuard>("gate", { enforcing: true });

    expect(await failureOf(drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, system: "House rules.", gate })))).toBe(`${stage} failed`);
    expect(fake.log).toEqual(log);
    expect({ judges: [...fake.judges.keys()], listening: fake.listening(), leases: fake.leases }).toEqual({
        judges: [],
        listening: false,
        leases: { selections: [{ providerID: "xai" }], active: 0, released: 1 },
    });
});

test("the runtime stays leased until MCP cleanup completes", async () => {
    const entered = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const fake = fakeOpenCode({
        replies: [[succeeded("s1")]],
        unmount: async () => {
            entered.resolve();
            await cleanup.promise;
        },
    });
    const finished = drain(createOpenCodeRunner(fake.openCode)(runnerTurn));
    await entered.promise;

    expect({ active: fake.leases.active, released: fake.leases.released }).toEqual({ active: 1, released: 0 });
    cleanup.resolve();
    await finished;
    expect({ active: fake.leases.active, released: fake.leases.released }).toEqual({ active: 0, released: 1 });
});

test("a cleanup failure still releases the runtime lease", async () => {
    const fake = fakeOpenCode({
        replies: [[succeeded("s1")]],
        unmount: async () => {
            throw new Error("cleanup failed");
        },
    });

    expect(await failureOf(drain(createOpenCodeRunner(fake.openCode)(runnerTurn)))).toBe("cleanup failed");
    expect({ active: fake.leases.active, released: fake.leases.released }).toEqual({ active: 0, released: 1 });
});

test("closing the consumer mid-turn stops listening, lets go of the servers, and only then releases the runtime", async () => {
    const opened = started("s1");
    const fake = fakeOpenCode({ replies: [[opened]] });
    const turn = createOpenCodeRunner(fake.openCode)(runnerTurn)[Symbol.asyncIterator]();

    expect(await turn.next()).toEqual({ done: false, value: session("s1", true) });
    expect(await turn.next()).toEqual({ done: false, value: opened });
    expect(fake.leases.active).toBe(1);
    expect(await turn.return?.()).toEqual({ done: true, value: undefined });
    expect(fake.log).toEqual(["acquire", "create", "listen", "mount", "prompt", "unlisten", "unmount", "release"]);
    expect(fake.leases.active).toBe(0);
});

// The runtime is shared: `intentic-gemini` is the same adapter serving Google, so a failure must name the backend the
// user actually picked.
test("a stalled turn is interrupted, and reported against the backend the user actually picked", async () => {
    jest.useFakeTimers();
    const stalled = async (provider: string | undefined) => {
        const fake = fakeOpenCode({ replies: [[started("s1")]] });
        const failure = failureOf(drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, ...opt("provider", provider) })));
        await advanceTimersByTimeAsync(DEFAULT_TURN_TIMEOUTS.inactivityMs);
        return { message: await failure, interrupts: fake.calls.interrupt, released: fake.leases.released };
    };
    const silence = "nothing arrived for 2m 0s, past the 2m 0s silence limit, 2m 0s into the turn.";

    expect(await stalled(undefined)).toEqual({
        message: `Grok turn timed out waiting for OpenCode: ${silence}`,
        interrupts: [{ sessionID: "s1" }],
        released: 1,
    });
    expect(await stalled(OPENCODE_GEMINI_PROVIDER)).toEqual({
        message: `Google turn timed out waiting for OpenCode: ${silence}`,
        interrupts: [{ sessionID: "s1" }],
        released: 1,
    });
});

// OpenCode 2 sends no status heartbeat: what keeps a turn alive is its family actually doing something.
test("every event of the session family keeps the watchdog fed, a subagent's included, and a stranger's does not", async () => {
    jest.useFakeTimers();
    const reply = [started("s1"), sessionCreated("child-1", "s1"), started("child-1")];
    const fake = fakeOpenCode({ replies: [reply] });
    const seen: OpenCodeTurnEvent[] = [];
    const failure = failureOf(drainInto(createOpenCodeRunner(fake.openCode, { ...DEFAULT_TURN_TIMEOUTS, inactivityMs: 1_000 })(runnerTurn), seen));
    const working = [textDelta("child-1", "Still looking."), textDelta("child-1", "Almost there.")];
    for (const event of working) {
        await advanceTimersByTimeAsync(900);
        fake.emit(event);
    }
    await advanceTimersByTimeAsync(900);
    fake.emit(textDelta("stranger", "Busy elsewhere."));
    await advanceTimersByTimeAsync(100);

    expect(await failure).toBe("Grok turn timed out waiting for OpenCode: nothing arrived for 1s, past the 1s silence limit, 3s into the turn.");
    expect(seen).toEqual([session("s1", true), ...reply, ...working]);
});

// The shared server's stream ending means it went away, not that the turn finished; only the turn's own stop explains it.
test("a lost stream is the server going away, said against the backend the user picked", async () => {
    const fake = fakeOpenCode({
        replies: [[started("s1"), toolStarted("s1", "c1", "shell"), toolCalled("s1", "c1", { command: "pnpm test" }), new Error("socket closed")]],
    });

    // The tool call is left in progress, which is the truth.
    expect(await collect(createOpenCodeAgent(createOpenCodeRunner(fake.openCode), OPENCODE_GEMINI_PROVIDER), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
        { kind: "error", message: "Google stopped sending events before the turn ended." },
        { kind: "done" },
    ]);
});

test("a stopped turn ends quietly, its session told to stop, whatever the stream does after", async () => {
    const opened = started("s1");
    const interruption = interrupted("s1", "user");
    const fake = fakeOpenCode({ replies: [[opened]], onInterrupt: [interruption, new Error("socket closed")] });
    const controller = new AbortController();
    const turn = createOpenCodeRunner(fake.openCode)({ ...runnerTurn, signal: controller.signal })[Symbol.asyncIterator]();
    expect(await turn.next()).toEqual({ done: false, value: session("s1", true) });
    expect(await turn.next()).toEqual({ done: false, value: opened });

    controller.abort();
    expect(await turn.next()).toEqual({ done: false, value: interruption });
    expect(await turn.next()).toEqual({ done: true, value: undefined });
    expect(fake.calls.interrupt).toEqual([{ sessionID: "s1" }]);
    expect(fake.leases.released).toBe(1);
});

test("OpenCode interrupting a turn this turn did not stop is a failure that names why", async () => {
    const fake = fakeOpenCode({ replies: [[started("s1"), textDelta("s1", "Working."), interrupted("s1", "shutdown")]] });

    expect(await collect(createOpenCodeAgent(createOpenCodeRunner(fake.openCode)), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "delta", text: "Working." },
        { kind: "error", message: "OpenCode stopped the Grok turn (shutdown)." },
        { kind: "done" },
    ]);
});

// A Stop before the session exists reaches an already-aborted signal, which a fresh listener never fires on.
test("a turn stopped before its session existed still tells OpenCode to stop it, and ends quietly", async () => {
    const fake = fakeOpenCode();
    const controller = new AbortController();
    controller.abort();

    expect(await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, signal: controller.signal }))).toEqual([session("s1", true)]);
    expect(fake.calls.interrupt).toEqual([{ sessionID: "s1" }]);
    expect(fake.leases).toEqual({ selections: [{ providerID: "xai" }], active: 0, released: 1 });
});

// The abort handler interrupts the session as soon as it exists, and the turn once went on to send its prompt after
// that: the execution it started was never interrupted, and the turn, returning at once, released its judges, leaving
// that execution running with every permission it asked given the standing yes.
test("a turn stopped before its prompt went out sends no prompt, so no execution of it runs", async () => {
    const fake = fakeOpenCode({ replies: [[started("s1")]] });
    const controller = new AbortController();
    controller.abort();
    await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, signal: controller.signal }));

    expect(fake.log.filter((step) => step === "prompt" || step === "interrupt")).toEqual(["interrupt"]);
});

// The Stop's interrupt and the prompt are two requests in flight together, and the interrupt can be taken first, while
// nothing runs yet; the execution the prompt then starts is interrupted again once the prompt is in.
test("a turn stopped while its prompt is on its way interrupts the execution the prompt started", async () => {
    const controller = new AbortController();
    const fake = fakeOpenCode({ beforePrompt: () => controller.abort() });

    expect(await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, signal: controller.signal }))).toEqual([session("s1", true)]);
    expect(fake.log.filter((step) => step === "prompt" || step === "interrupt")).toEqual(["interrupt", "prompt", "interrupt"]);
    expect(fake.leases).toEqual({ selections: [{ providerID: "xai" }], active: 0, released: 1 });
});

test("a retry's announced next attempt pushes the inactivity deadline past it", async () => {
    jest.useFakeTimers();
    const retry = retryScheduled("s1", 1, Date.now() + 5_000, { type: "provider.rate-limit", message: "429", status: 429 });
    const fake = fakeOpenCode({ replies: [[started("s1"), retry]] });
    let ended = false;
    const failure = failureOf(drain(createOpenCodeRunner(fake.openCode, { ...DEFAULT_TURN_TIMEOUTS, inactivityMs: 1_000 })(runnerTurn))).finally(() => {
        ended = true;
    });

    await advanceTimersByTimeAsync(5_999);
    expect(ended).toBe(false);
    await advanceTimersByTimeAsync(1);
    // The deadline moved; the sentence still names the configured silence limit it was measured against.
    expect(await failure).toBe("Grok turn timed out waiting for OpenCode: nothing arrived for 6s, past the 1s silence limit, 6s into the turn.");
});

// The detached permission watcher answers asks, but the card it raises is this turn's: it goes out on the turn's own
// stream, and while it waits on a person the turn's silence limit is held, then runs again from the answer.
test("a card the turn's judge raises goes out in order, and the turn waits on it past the silence window", async () => {
    jest.useFakeTimers();
    const opened = started("s1");
    const fake = fakeOpenCode({ replies: [[opened]] });
    const gate = unstubbed<CommandGuard>("gate", { enforcing: true });
    const card: AgentEvent = {
        kind: "permission",
        requestId: "card-1",
        toolName: "Bash",
        title: "This command would push to main",
        displayName: "Run command",
    };
    const answer: AgentEvent = { kind: "resolved", requestId: "card-1" };
    const turn = createOpenCodeRunner(fake.openCode, { ...DEFAULT_TURN_TIMEOUTS, inactivityMs: 1_000 })({ ...runnerTurn, gate })[Symbol.asyncIterator]();
    expect(await turn.next()).toEqual({ done: false, value: session("s1", true) });
    expect(await turn.next()).toEqual({ done: false, value: opened });
    const judge = fake.judges.get("s1");
    if (judge === undefined) {
        throw new Error("the turn registered no judge for its own session");
    }

    // As answerPermission does: the clock held for the whole consult, the card raised, then its resolution.
    const release = judge.hold();
    judge.push(card);
    expect(await turn.next()).toEqual({ done: false, value: raised(card) });
    let answered = false;
    const waiting = turn.next().finally(() => {
        answered = true;
    });
    // Ten silence windows on a card, and the turn is still waiting rather than timed out.
    await advanceTimersByTimeAsync(10_000);
    expect(answered).toBe(false);
    judge.push(answer);
    release();
    expect(await waiting).toEqual({ done: false, value: raised(answer) });
    // Answered, the turn is back on the clock: silence from here is a stall again.
    const stalled = failureOf(turn.next());
    await advanceTimersByTimeAsync(1_000);
    expect(await stalled).toBe("Grok turn timed out waiting for OpenCode: nothing arrived for 1s, past the 1s silence limit, 11s into the turn.");
});

// ---------------------------------------------------------------------------------------------------------------------
// Background work: a shell the model sent to the background, or a subagent still running when the turn's own work ends.

// The shell's progress names it; its output reaches the session as a new execution once it ends, not as it goes.
test("a turn waits past its success while a background shell runs, then takes in the execution its ending wakes", async () => {
    jest.useFakeTimers();
    const reply = [
        started("s1"),
        toolStarted("s1", "c1", "shell"),
        toolCalled("s1", "c1", { command: "sleep 300; echo done", background: true }),
        toolProgress("s1", "c1", { shellID: "sh1" }),
        toolSucceeded("s1", "c1", "Started in the background."),
        succeeded("s1"),
    ];
    const fake = fakeOpenCode({ replies: [reply] });
    const seen: OpenCodeTurnEvent[] = [];
    let ended = false;
    const finished = drainInto(createOpenCodeRunner(fake.openCode)(runnerTurn), seen).finally(() => {
        ended = true;
    });

    // Five silence windows with nothing heard, and the turn is still waiting on its shell.
    await advanceTimersByTimeAsync(5 * DEFAULT_TURN_TIMEOUTS.inactivityMs);
    expect(ended).toBe(false);
    const woken = [started("s1"), textDelta("s1", "The shell printed done."), succeeded("s1")];
    fake.emit(shellExited("sh1"), ...woken);
    await finished;

    // The shell's own ending is no frame of the turn's.
    expect(seen).toEqual([session("s1", true), ...reply, ...woken]);
    expect(fake.calls.removeShell).toEqual([]);
});

test("a background shell's ending that wakes nothing ends the turn once the follow-up wait passes", async () => {
    jest.useFakeTimers();
    const fake = fakeOpenCode({ replies: [[started("s1"), toolProgress("s1", "c1", { shellID: "sh1" }), succeeded("s1")]] });
    let ended = false;
    const finished = drain(createOpenCodeRunner(fake.openCode)(runnerTurn)).finally(() => {
        ended = true;
    });
    await realYield();
    fake.emit(shellDeleted("sh1"));

    await advanceTimersByTimeAsync(4_999);
    expect(ended).toBe(false);
    await advanceTimersByTimeAsync(1);
    await finished;
    expect(fake.log.slice(-3)).toEqual(["unlisten", "unmount", "release"]);
});

test("a subagent still running when the turn's own work ends is waited for, then the follow-up wait", async () => {
    jest.useFakeTimers();
    const reply = [started("s1"), sessionCreated("child-1", "s1"), started("child-1"), succeeded("s1")];
    const fake = fakeOpenCode({ replies: [reply] });
    const seen: OpenCodeTurnEvent[] = [];
    let ended = false;
    const finished = drainInto(createOpenCodeRunner(fake.openCode)(runnerTurn), seen).finally(() => {
        ended = true;
    });

    await advanceTimersByTimeAsync(60_000);
    expect(ended).toBe(false);
    const report = [textDelta("child-1", "Found it."), succeeded("child-1")];
    fake.emit(...report);
    await advanceTimersByTimeAsync(4_999);
    expect(ended).toBe(false);
    await advanceTimersByTimeAsync(1);
    await finished;
    expect(seen).toEqual([session("s1", true), ...reply, ...report]);
});

// A turn waiting on a background shell has no execution for OpenCode to say it interrupted; the Stop itself ends the wait,
// and a shell outliving its turn would wake the session with nobody judging what it does next.
test("stopping a turn that waits on a background shell ends it, and the shell is removed", async () => {
    const reply = [started("s1"), toolProgress("s1", "c1", { shellID: "sh1" }), succeeded("s1")];
    const fake = fakeOpenCode({ replies: [reply] });
    const controller = new AbortController();
    const turn = createOpenCodeRunner(fake.openCode)({ ...runnerTurn, signal: controller.signal })[Symbol.asyncIterator]();
    const heard: (OpenCodeTurnEvent | undefined)[] = [];
    for (let count = 0; count < 4; count += 1) {
        heard.push((await turn.next()).value);
    }
    expect(heard).toEqual([session("s1", true), ...reply]);

    const waiting = turn.next();
    controller.abort();
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(fake.calls.removeShell).toEqual([{ id: "sh1", location: { directory: WORKSPACE_ROOT } }]);
    expect(fake.log.slice(-6)).toEqual(["prompt", "interrupt", "unlisten", "removeShell", "unmount", "release"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// xAI names the account's valid models when it rejects a stale or renamed id.

const STALE: StructuredError = {
    type: "provider.not-found",
    message: "Model not found: xai/grok-4-stale",
    status: 404,
    response: { body: '{"error":"Model not found: xai/grok-4-stale. Did you mean: grok-4-latest, grok-imagine-1?"}' },
};

test("a model-not-found naming alternatives self-heals: records the chat models, switches the session's model, and re-prompts once", async () => {
    const opened = started("s1");
    const second = [started("s1"), textDelta("s1", "Fixed."), succeeded("s1")];
    const fake = fakeOpenCode({ replies: [[opened, failed("s1", STALE)], second] });

    // The failure the heal answered is not the turn's.
    expect(await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, model: "grok-4-stale" }))).toEqual([session("s1", true), opened, ...second]);
    expect(fake.calls.recorded).toEqual([["grok-4-latest"]]);
    expect(fake.calls.switchModel).toEqual([{ sessionID: "s1", model: { providerID: "xai", id: "grok-4-latest" } }]);
    expect(fake.calls.prompt).toEqual([
        { sessionID: "s1", text: "hi" },
        { sessionID: "s1", text: "hi" },
    ]);
});

test("a second model failure after the self-heal surfaces as the turn's", async () => {
    const again = failed("s1", { type: "provider.not-found", message: "Model not found: xai/grok-4-latest. Did you mean: grok-4-latest?" });
    const fake = fakeOpenCode({ replies: [[started("s1"), failed("s1", STALE)], [started("s1"), again]] });

    expect(await collect(createOpenCodeAgent(createOpenCodeRunner(fake.openCode)), { ...request, spec: { ...request.spec, model: "grok-4-stale" } })).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "error", code: "grok-model-invalid", message: "Model not found: xai/grok-4-latest. Did you mean: grok-4-latest?" },
        { kind: "done" },
    ]);
    expect({ recorded: fake.calls.recorded, prompts: fake.calls.prompt.length }).toEqual({ recorded: [["grok-4-latest"]], prompts: 2 });
});

test("a model error naming no alternative surfaces as it came, recording nothing", async () => {
    const reply = [started("s1"), failed("s1", { type: "provider.not-found", message: "Model not found: xai/grok-x" })];
    const fake = fakeOpenCode({ replies: [reply] });

    expect(await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, model: "grok-x" }))).toEqual([session("s1", true), ...reply]);
    expect({ recorded: fake.calls.recorded, switchModel: fake.calls.switchModel, prompts: fake.calls.prompt.length }).toEqual({
        recorded: [],
        switchModel: [],
        prompts: 1,
    });
});

// Google must never silently substitute another model.
test("a Google turn never self-heals, even when the failure names alternatives", async () => {
    const reply = [started("s1"), failed("s1", STALE)];
    const fake = fakeOpenCode({ replies: [reply] });

    expect(await drain(createOpenCodeRunner(fake.openCode)({ ...runnerTurn, provider: OPENCODE_GEMINI_PROVIDER, model: "gemini-3-flash" }))).toEqual([
        session("s1", true),
        ...reply,
    ]);
    expect({ recorded: fake.calls.recorded, prompts: fake.calls.prompt.length }).toEqual({ recorded: [], prompts: 1 });
});

// Tagged for parity with the event path, so the client reloads the catalog.
test("a thrown model-not-found surfaces as a tagged grok-model-invalid error", async () => {
    const fake = fakeOpenCode({ fails: { prompt: new Error("Model not found: xai/grok-x.") } });

    expect(await collect(createOpenCodeAgent(createOpenCodeRunner(fake.openCode)), { ...request, spec: { ...request.spec, model: "grok-x" } })).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "error", code: "grok-model-invalid", message: "Model not found: xai/grok-x." },
        { kind: "done" },
    ]);
    expect(fake.calls.recorded).toEqual([]);
});

import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest, MuseCredential } from "../../agent/providers/agent-request.js";
import { SteeringQueue } from "../../agent/checkpoints/agent-steering.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";
import { createMuseAgent } from "./muse-agent.js";
import { type FakeMuseOptions, fakeMuse, museItem, museShellApproval } from "./muse-host.testing.js";
import { PLANNING_REFUSAL } from "./muse-asks.js";
import { POST_PLAN_MODE } from "../../agent/run/agent.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

const request = (overrides: Partial<AgentRequest<MuseCredential>> = {}): AgentRequest<MuseCredential> => ({
    execution: unstubbed("execution", {}),
    spec: { prompt: "add a /ping route", cwd: WORKSPACE_ROOT, conversationId: "c1" },
    policy: {},
    tools: {},
    credential: { kind: "muse", apiKey: "meta-key" },
    hooks: { cards },
    signal: new AbortController().signal,
    ...overrides,
});

const agentOn = (options: FakeMuseOptions) => {
    const muse = fakeMuse(options);
    return { muse, agent: createMuseAgent({ open: muse.open, binary: async () => "/opt/muse/muse" }) };
};

// Every frame of one turn; a card is answered the moment it is shown, after the loop has parked on it.
const collect = async (
    agent: ReturnType<typeof createMuseAgent>,
    turn: AgentRequest<MuseCredential>,
    answer: (event: AgentEvent) => Parameters<typeof cards.resolve>[0] | undefined = () => undefined,
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turn)) {
        events.push(event);
        const reply = answer(event);
        if (reply !== undefined) {
            setTimeout(() => cards.resolve(reply), 0);
        }
    }
    return events;
};

test("a turn opens a session with the turn's MCP servers, streams its frames, and closes its host", async () => {
    const { muse, agent } = agentOn({
        models: [{ modelId: "muse-spark-1.2", isDefault: true, variants: ["low", "medium", "high"] }],
        turns: [
            (turn) => {
                turn.emit("item/delta", { sessionId: turn.sessionId, viewCursor: "v", itemId: "m1", field: "text", delta: "Done." });
                museItem(turn, "item/completed", { itemId: "m1", kind: "agentMessage", status: "completed", text: "Done." });
                turn.emit("session/tokenUsage", {
                    sessionId: turn.sessionId,
                    turnId: turn.turnId,
                    viewCursor: "v",
                    sourceRange: {},
                    promptTokens: 10,
                    totalTokens: 12,
                    modelId: "muse-spark-1.2",
                    cumulative: { outputTokens: 2, promptTokens: 10, totalTokens: 12 },
                    usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0 },
                });
                turn.complete("completed", { durationMs: 42 });
            },
        ],
    });
    const events = await collect(
        agent,
        request({
            spec: { prompt: "add a /ping route", cwd: WORKSPACE_ROOT, conversationId: "c1", model: "muse-spark-9", effort: "high" },
            tools: { remote: [{ name: "browser", url: "http://127.0.0.1:9/mcp/browser", token: "lease" }] },
        }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s1" },
        // A pick Muse's own list does not serve falls to its default.
        { kind: "init", model: "muse-spark-1.2" },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "usage", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 42 },
        { kind: "done" },
    ]);
    const start = muse.commands.find((command) => command.method === "session/start");
    expect(start?.params).toMatchObject({
        workspaceRoot: WORKSPACE_ROOT,
        approvalMode: "promptUnmatched",
        modelId: "muse-spark-1.2",
        config: { mcpServers: { browser: { transport: "streamableHttp", url: "http://127.0.0.1:9/mcp/browser", mode: "optional", headers: { Authorization: "Bearer lease" } } } },
    });
    expect(muse.commands.find((command) => command.method === "turn/start")?.params).toMatchObject({
        sessionId: "s1",
        input: [{ type: "text", text: "add a /ping route" }],
        reasoningEffort: "high",
    });
    const launch = muse.launches[0];
    expect(launch?.args).toEqual(["--disable-sandbox", "--trust-workspace"]);
    expect(launch?.env["META_API_KEY"]).toBe("meta-key");
    expect(launch?.env["XDG_CONFIG_HOME"]).toBeUndefined();
    expect(muse.closed()).toBe(1);
});

test("a resumed session Muse still holds is resumed; one it lost opens fresh instead of failing the turn", async () => {
    const held = agentOn({ resume: "held", turns: [(turn) => turn.complete()] });
    await collect(held.agent, request({ spec: { prompt: "next", cwd: WORKSPACE_ROOT, sessionId: "old" } }));
    expect(held.muse.commands.map((command) => command.method)).toEqual(["session/resume", "turn/start"]);

    const lost = agentOn({ resume: "lost", turns: [(turn) => turn.complete()] });
    const events = await collect(lost.agent, request({ spec: { prompt: "next", cwd: WORKSPACE_ROOT, sessionId: "gone" } }));
    expect(lost.muse.commands.map((command) => command.method)).toEqual(["session/resume", "session/start", "turn/start"]);
    expect(events[0]).toEqual({ kind: "session", sessionId: "s1" });
});

test("in default mode a shell command Muse raises is put to the person, and their answer goes back once-scoped", async () => {
    const { muse, agent } = agentOn({
        turns: [
            async (turn) => {
                museShellApproval(turn, "a1", "pnpm test");
                const allowed = await turn.next("approval/decide");
                museShellApproval(turn, "a2", "rm -rf build");
                const refused = await turn.next("approval/decide");
                expect([allowed, refused]).toEqual([
                    { sessionId: "s1", approvalId: "a1", choiceId: "allow_once", requirementId: { approvalId: "a1", sourceIndex: 0 } },
                    expect.objectContaining({ approvalId: "a2", choiceId: "abort", feedback: expect.stringContaining("declined") }),
                ]);
                turn.complete();
            },
        ],
    });
    let asked = 0;
    const events = await collect(agent, request({ policy: { permissionMode: "default" } }), (event) => {
        if (event.kind !== "permission") {
            return undefined;
        }
        asked += 1;
        return { kind: "permission", requestId: event.requestId, decision: asked === 1 ? "once" : "deny" };
    });
    const cardsShown = events.filter((event) => event.kind === "permission");
    expect(cardsShown).toHaveLength(2);
    expect(cardsShown[0]).toMatchObject({ toolName: "Bash", title: "Run this command?", program: { text: "pnpm test", language: "bash" } });
    expect(muse.commands.filter((command) => command.method === "approval/decide")).toHaveLength(2);
});

test("outside default mode the rulebook alone answers: a command it lets through runs without a card", async () => {
    const { muse, agent } = agentOn({
        turns: [
            async (turn) => {
                museShellApproval(turn, "a1", "ls");
                await turn.next("approval/decide");
                turn.complete();
            },
        ],
    });
    const events = await collect(agent, request({ policy: { permissionMode: "bypassPermissions" } }));
    expect(events.some((event) => event.kind === "permission")).toBe(false);
    expect(muse.commands.find((command) => command.method === "approval/decide")?.params).toMatchObject({ choiceId: "allow_once" });
});

test("a question parks on the question card and the person's pick goes back as Muse's own answer", async () => {
    const { muse, agent } = agentOn({
        turns: [
            async (turn) => {
                turn.emit("userInput/requested", {
                    sessionId: turn.sessionId,
                    turnId: turn.turnId,
                    userInputId: "q1",
                    itemId: "i1",
                    toolCallId: "call",
                    toolName: "request_user_input",
                    viewCursor: "v",
                    questions: [
                        {
                            id: "db",
                            header: "Database",
                            question: "Which database?",
                            options: [{ label: "Postgres", description: "relational" }, { label: "SQLite" }],
                            selection: { mode: "single" },
                        },
                    ],
                });
                await turn.next("userInput/answer");
                turn.complete();
            },
        ],
    });
    const events = await collect(agent, request(), (event) =>
        event.kind === "question" ? { kind: "question", requestId: event.requestId, answers: { "Which database?": ["Postgres"] } } : undefined,
    );
    expect(events.find((event) => event.kind === "question")).toMatchObject({
        questions: [{ question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite", description: "" }] }],
    });
    expect(muse.commands.find((command) => command.method === "userInput/answer")?.params).toEqual({
        sessionId: "s1",
        userInputId: "q1",
        answers: [{ questionId: "db", selectedLabel: "Postgres" }],
    });
});

test("a plan turn plans on Muse's read-only profile, refuses every approval, and executes on the ordinary one once approved", async () => {
    const { muse, agent } = agentOn({
        turns: [
            async (turn) => {
                museShellApproval(turn, "a1", "touch x");
                await turn.next("approval/decide");
                museItem(turn, "item/completed", { itemId: "m1", kind: "agentMessage", status: "completed", text: "1. Add the route." });
                turn.complete();
            },
            (turn) => {
                museItem(turn, "item/completed", { itemId: "m2", kind: "agentMessage", status: "completed", text: "Added." });
                turn.complete();
            },
        ],
    });
    const events = await collect(agent, request({ policy: { permissionMode: "plan" } }), (event) =>
        event.kind === "plan" ? { kind: "plan", requestId: event.requestId, approve: true } : undefined,
    );
    expect(muse.commands.find((command) => command.method === "session/start")?.params).toMatchObject({ permissionProfile: ":read-only" });
    expect(muse.commands.find((command) => command.method === "approval/decide")?.params).toMatchObject({ choiceId: "abort", feedback: PLANNING_REFUSAL });
    expect(events.find((event) => event.kind === "plan")).toMatchObject({ text: "1. Add the route." });
    expect(events).toContainEqual({ kind: "mode", mode: POST_PLAN_MODE });
    expect(muse.commands.filter((command) => command.method === "session/setPermissionProfile").map((command) => command.params["profileId"])).toEqual([":ask-me"]);
    expect(events).toContainEqual({ kind: "delta", text: "Added." });
});

test("a steer lands in the running turn as turn/steer", async () => {
    const steering = new SteeringQueue();
    const { muse, agent } = agentOn({
        turns: [
            async (turn) => {
                steering.push("use port 8080");
                const steered = await turn.next("turn/steer");
                expect(steered).toMatchObject({ sessionId: "s1", expectedTurnId: turn.turnId, input: [{ type: "text", text: "use port 8080" }] });
                turn.complete();
            },
        ],
    });
    await collect(agent, request({ spec: { prompt: "start the server", cwd: WORKSPACE_ROOT, steering } }));
    expect(muse.commands.some((command) => command.method === "turn/steer")).toBe(true);
});

test("a failed turn is coded for auto-resume, and a host that dies mid-turn says so", async () => {
    const quota = agentOn({
        turns: [(turn) => turn.complete("failed", { error: { kind: "modelError", message: "quota spent", retryable: false, quota: { limitKind: "tierLimit", resetsAtMs: 9 } } })],
    });
    expect(await collect(quota.agent, request())).toContainEqual({ kind: "error", message: "quota spent", code: "rate_limit" });

    const died = agentOn({ turns: [(turn) => turn.exit("Muse Code exited (SIGKILL)")] });
    expect(await collect(died.agent, request())).toContainEqual({ kind: "error", message: "Muse Code exited (SIGKILL)" });
});

test("a host that will not start ends the turn with its reason, and no binary at all names the fix", async () => {
    const refused = agentOn({ refuse: "Muse Code exited before it answered", turns: [] });
    expect(await collect(refused.agent, request())).toEqual([
        { kind: "error", message: "Muse Code: Muse Code exited before it answered" },
        { kind: "done" },
    ]);
    const missing = createMuseAgent({ open: fakeMuse({ turns: [] }).open, binary: async () => undefined });
    const events = await collect(missing, request());
    expect(events[0]).toMatchObject({ kind: "error", message: expect.stringContaining("Muse Code") });
});

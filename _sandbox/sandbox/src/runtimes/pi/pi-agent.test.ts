import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { AgentRequest, ContainerCredential, TurnPolicy, TurnSpec } from "../../agent/providers/agent-request.js";
import { SteeringQueue } from "../../agent/checkpoints/agent-steering.js";
import { createPiAgent } from "./pi-agent.js";
import type { TurnTimeouts } from "../decorators/turn-watchdog.js";
import type { PiEvent, PiProcessHandlers, PiResponse, PiSpawn } from "./pi-rpc.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// The Pi adapter over a scripted process (no spawn, no binary): a fake answers commands from a response table and
// scripts what streams after each accepted prompt, exercising the adapter's real loop end to end.

const SESSION_FILE = "/auth/pi/sessions/s1.jsonl";

// A function responder sees the request's signal and may answer later, or never (a Pi that took the command and went
// quiet).
type Responder = PiResponse | ((command: Record<string, unknown>, signal?: AbortSignal) => PiResponse | Promise<PiResponse>);

interface FakePi {
    readonly spawn: PiSpawn;
    // Every command the adapter sent (requests and fire-and-forget alike), in order.
    readonly sent: Record<string, unknown>[];
    readonly emit: (event: PiEvent) => void;
    readonly exit: (code: number | null) => void;
    readonly killed: () => boolean;
}

// `prompts` scripts the event burst after each accepted prompt, one entry per prompt in send order (the last repeats:
// plan revisions loop); `responses` overrides the defaults per command type.
const fakePi = (prompts: PiEvent[][] = [[{ type: "agent_settled" }]], responses: Record<string, Responder> = {}): FakePi => {
    const sent: Record<string, unknown>[] = [];
    let handlers: PiProcessHandlers | undefined;
    let killed = false;
    let exited = false;
    let promptCount = 0;

    const defaults: Record<string, Responder> = {
        get_state: { success: true, data: { sessionFile: SESSION_FILE, sessionId: "s1" } },
        get_commands: { success: true, data: { commands: [{ name: "skill:review", description: "Review the diff" }] } },
        get_session_stats: { success: true, data: { contextUsage: { tokens: 12_000, contextWindow: 200_000 } } },
        switch_session: { success: true, data: { cancelled: false } },
        set_model: { success: true },
        set_thinking_level: { success: true },
        steer: { success: true },
        follow_up: { success: true },
        abort: { success: true },
        prompt: { success: true },
    };

    const emit = (event: PiEvent): void => handlers?.onEvent(event);

    return {
        spawn: (_config, _cwd, spawnedHandlers) => {
            handlers = spawnedHandlers;
            return {
                request: async (command, signal) => {
                    // The production transport's contract (pi-rpc): a request whose signal has already aborted is never
                    // written.
                    if (signal?.aborted === true) {
                        throw signal.reason;
                    }
                    sent.push(command);
                    if (exited) {
                        // The production transport's answer once the process is gone (pi-rpc settleExit).
                        return { success: false, error: "the pi process exited" };
                    }
                    const type = command["type"] as string;
                    const responder = responses[type] ?? defaults[type] ?? { success: false, error: `unscripted command ${type}` };
                    const response = typeof responder === "function" ? await responder(command, signal) : responder;
                    if (type === "prompt" && response.success) {
                        const script = prompts[Math.min(promptCount, prompts.length - 1)] ?? [];
                        promptCount += 1;
                        // Stream after the acceptance response settles, like the real process would.
                        setTimeout(() => script.forEach(emit), 0);
                    }
                    return response;
                },
                send: (command) => {
                    sent.push(command);
                },
                alive: () => !killed,
                stderrTail: () => "",
                kill: () => {
                    killed = true;
                },
            };
        },
        sent,
        emit,
        exit: (code) => {
            exited = true;
            handlers?.onExit(code);
        },
        killed: () => killed,
    };
};

const request = (
    over: {
        readonly spec?: Pick<TurnSpec, "sessionId" | "model" | "effort" | "steering">;
        readonly policy?: Pick<TurnPolicy, "permissionMode">;
        readonly signal?: AbortSignal;
    } = {},
): AgentRequest<ContainerCredential> => ({
    execution: unstubbed("execution", {}),
    spec: { prompt: "add a /ping route", cwd: WORKSPACE_ROOT, ...over.spec },
    policy: { ...over.policy },
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: over.signal ?? new AbortController().signal,
});

const CONFIG = { command: "pi" };

// Collects all frames; `onPlan` fires via `setTimeout` since the generator's yield suspends before the pending-plan
// bridge's `wait()` registers.
const collect = async (
    turn: AsyncGenerator<AgentEvent>,
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of turn) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => cards.resolve({ kind: "plan", requestId: event.requestId, ...decision }), 0);
        }
    }
    return events;
};

test("a turn reports its session file, publishes commands, streams deltas, and settles with usage + context", async () => {
    const pi = fakePi([
        [
            { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "On it." } },
            {
                type: "message_end",
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
                },
            },
            { type: "agent_settled" },
        ],
    ]);
    const events = await collect(createPiAgent(pi.spawn)(CONFIG, request()));

    expect(events).toEqual([
        { kind: "session", sessionId: SESSION_FILE },
        { kind: "commands", items: [{ name: "skill:review", description: "Review the diff" }] },
        { kind: "delta", text: "On it." },
        { kind: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 },
        { kind: "context_usage", tokens: 12_000, contextWindow: 200_000 },
        { kind: "done" },
    ]);
    // The turn's process never outlives it: sessions are files, so there is nothing to keep warm.
    expect(pi.killed()).toBe(true);
});

test("a resume loads the recorded session file; one Pi rejects is the coded self-heal", async () => {
    const pi = fakePi();
    await collect(createPiAgent(pi.spawn)(CONFIG, request({ spec: { sessionId: SESSION_FILE } })));
    expect(pi.sent[0]).toMatchObject({ type: "switch_session", sessionPath: SESSION_FILE });

    const refusing = fakePi([], { switch_session: { success: false, error: "no such session" } });
    const events = await collect(createPiAgent(refusing.spawn)(CONFIG, request({ spec: { sessionId: "/gone.jsonl" } })));
    expect(events).toEqual([
        { kind: "error", code: "session-not-found", message: "Pi no longer has this chat's session. Send again to start fresh." },
        { kind: "done" },
    ]);
});

test("a deliberate model pin rides set_model as provider/model-id, and a rejected pin fails the turn honestly", async () => {
    const pi = fakePi();
    await collect(createPiAgent(pi.spawn)(CONFIG, request({ spec: { model: "anthropic/claude-sonnet-5" } })));
    expect(pi.sent).toContainEqual({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" });

    const refusing = fakePi([], { set_model: { success: false, error: "Model not found" } });
    const events = await collect(createPiAgent(refusing.spawn)(CONFIG, request({ spec: { model: "anthropic/claude-nonexistent" } })));
    expect(events.map((event) => event.kind)).toEqual(["session", "error", "done"]);
});

test("effort rides set_thinking_level, and a tier the model lacks is tolerated rather than fatal", async () => {
    const pi = fakePi([[{ type: "agent_settled" }]], { set_thinking_level: { success: false, error: "not supported" } });
    const events = await collect(createPiAgent(pi.spawn)(CONFIG, request({ spec: { effort: "high" } })));
    expect(pi.sent).toContainEqual({ type: "set_thinking_level", level: "high" });
    expect(events.some((event) => event.kind === "error")).toBe(false);
});

test("steering messages are forwarded onto Pi's steer queue mid-turn", async () => {
    const steering = new SteeringQueue();
    // The prompt's script parks the turn until the steer arrives; the steer response releases it.
    const pi = fakePi([[]], {
        steer: (command) => {
            expect(command["message"]).toBe("also add a test");
            setTimeout(() => pi.emit({ type: "agent_settled" }), 0);
            return { success: true };
        },
    });
    const turn = collect(createPiAgent(pi.spawn)(CONFIG, request({ spec: { steering } })));
    steering.push("also add a test");
    steering.close();
    await turn;
    expect(pi.sent).toContainEqual({ type: "steer", message: "also add a test" });
});

test("a steer Pi refuses (agent momentarily idle) is re-queued as a follow_up, not dropped", async () => {
    const steering = new SteeringQueue();
    const pi = fakePi([[]], {
        steer: { success: false, error: "agent is not running" },
        follow_up: (command) => {
            expect(command["message"]).toBe("one more thing");
            setTimeout(() => pi.emit({ type: "agent_settled" }), 0);
            return { success: true };
        },
    });
    const turn = collect(createPiAgent(pi.spawn)(CONFIG, request({ spec: { steering } })));
    steering.push("one more thing");
    steering.close();
    await turn;
    expect(pi.sent).toContainEqual({ type: "follow_up", message: "one more thing" });
});

test("plan mode holds the plan text back, parks on the plan card, and executes on approval", async () => {
    const pi = fakePi([
        [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "1. Add route\n2. Add test" } }, { type: "agent_settled" }],
        [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } }, { type: "agent_settled" }],
    ]);
    const events = await collect(createPiAgent(pi.spawn)(CONFIG, request({ policy: { permissionMode: "plan" } })), () => ({ approve: true }));

    const plan = events.find((event) => event.kind === "plan");
    expect(plan).toMatchObject({ text: "1. Add route\n2. Add test" });
    // The plan text never streamed as deltas; the execute phase's narration did.
    expect(events.filter((event) => event.kind === "delta")).toEqual([{ kind: "delta", text: "Done." }]);
    const prompts = pi.sent.filter((command) => command["type"] === "prompt");
    expect(prompts).toHaveLength(2);
    expect(String(prompts[1]?.["message"])).toContain("approved");
});

// Collects a turn's frames, answering each question card it raises with `answer` (the reply minus its kind and id).
const collectAnswering = async (
    turn: AsyncGenerator<AgentEvent>,
    answer: (questions: Extract<AgentEvent, { kind: "question" }>["questions"]) => { answers?: Record<string, string[]>; cancelled?: boolean },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of turn) {
        events.push(event);
        if (event.kind === "question") {
            const reply = answer(event.questions);
            setTimeout(() => cards.resolve({ kind: "question", requestId: event.requestId, ...reply }), 0);
        }
    }
    return events;
};

const uiResponses = (pi: FakePi): Record<string, unknown>[] => pi.sent.filter((command) => command["type"] === "extension_ui_response");

test("what an extension shows becomes the agent UI lane: notices, status entries and widgets, with no reply", async () => {
    const pi = fakePi([
        [
            { type: "extension_ui_request", id: "u1", method: "notify", message: "Command blocked by user", notifyType: "warning" },
            { type: "extension_ui_request", id: "u2", method: "notify", message: "fyi" },
            { type: "extension_ui_request", id: "u3", method: "setStatus", statusKey: "lint", statusText: "linting 3 files" },
            { type: "extension_ui_request", id: "u4", method: "setWidget", widgetKey: "todo", widgetLines: ["- one", "- two"], widgetPlacement: "belowEditor" },
            { type: "extension_ui_request", id: "u5", method: "setStatus", statusKey: "lint" },
            { type: "extension_ui_request", id: "u6", method: "setWidget", widgetKey: "todo" },
            { type: "extension_ui_request", id: "u7", method: "setTitle", title: "pi - project" },
            { type: "extension_ui_request", id: "u8", method: "set_editor_text", text: "prefilled" },
            { type: "agent_settled" },
        ],
    ]);
    const events = await collect(createPiAgent(pi.spawn)(CONFIG, request()));
    expect(events.filter((event) => event.kind === "agent_notice" || event.kind === "agent_status")).toEqual([
        { kind: "agent_notice", level: "warning", text: "Command blocked by user" },
        { kind: "agent_notice", level: "info", text: "fyi" },
        { kind: "agent_status", key: "lint", text: "linting 3 files" },
        { kind: "agent_status", key: "widget:todo", text: "- one\n- two" },
        { kind: "agent_status", key: "lint", text: null },
        { kind: "agent_status", key: "widget:todo", text: null },
    ]);
    expect(uiResponses(pi)).toEqual([]);
});

test("an extension's confirm parks on a question card, and the pick goes back as its confirmation", async () => {
    const pi = fakePi([
        [
            { type: "extension_ui_request", id: "c1", method: "confirm", title: "Clear session?", message: "All messages will be lost." },
            { type: "agent_settled" },
        ],
    ]);
    const events = await collectAnswering(createPiAgent(pi.spawn)(CONFIG, request()), (questions) => ({ answers: { [questions[0]?.question ?? ""]: ["Yes"] } }));
    expect(events.find((event) => event.kind === "question")).toMatchObject({
        questions: [
            {
                question: "Clear session?\n\nAll messages will be lost.",
                header: "Pi extension",
                multiSelect: false,
                options: [
                    { label: "Yes", description: "" },
                    { label: "No", description: "" },
                ],
            },
        ],
    });
    // The card is frozen before the turn goes on.
    expect(events.map((event) => event.kind)).toContain("resolved");
    expect(uiResponses(pi)).toEqual([{ type: "extension_ui_response", id: "c1", confirmed: true }]);
});

test("a select returns the picked option, and an input the person's own words", async () => {
    const pi = fakePi([
        [
            { type: "extension_ui_request", id: "s1", method: "select", title: "Allow dangerous command?", options: ["Allow", "Block"] },
            { type: "extension_ui_request", id: "i1", method: "input", title: "Branch name", placeholder: "feature/…" },
            { type: "agent_settled" },
        ],
    ]);
    const events = await collectAnswering(createPiAgent(pi.spawn)(CONFIG, request()), (questions) => {
        const question = questions[0]?.question ?? "";
        return { answers: { [question]: [question === "Allow dangerous command?" ? "Block" : "feature/ping"] } };
    });
    expect(events.filter((event) => event.kind === "question").map((event) => event.questions[0])).toEqual([
        {
            question: "Allow dangerous command?",
            header: "Pi extension",
            multiSelect: false,
            options: [
                { label: "Allow", description: "" },
                { label: "Block", description: "" },
            ],
        },
        { question: "Branch name (feature/…)", header: "Pi extension", multiSelect: false, options: [] },
    ]);
    expect(uiResponses(pi)).toEqual([
        { type: "extension_ui_response", id: "s1", value: "Block" },
        { type: "extension_ui_response", id: "i1", value: "feature/ping" },
    ]);
});

test("a dismissed card cancels the dialog, and an editor dialog, with no card that fits, is cancelled at once", async () => {
    const pi = fakePi([
        [
            { type: "extension_ui_request", id: "e1", method: "editor", title: "Edit", prefill: "a\nb" },
            { type: "extension_ui_request", id: "c1", method: "confirm", title: "Clear session?" },
            { type: "agent_settled" },
        ],
    ]);
    const events = await collectAnswering(createPiAgent(pi.spawn)(CONFIG, request()), () => ({ cancelled: true }));
    expect(events.filter((event) => event.kind === "question")).toHaveLength(1);
    expect(uiResponses(pi)).toEqual([
        { type: "extension_ui_response", id: "e1", cancelled: true },
        { type: "extension_ui_response", id: "c1", cancelled: true },
    ]);
});

test("a dialog Pi times out by itself takes its card with it and gets no reply", async () => {
    const pi = fakePi([[{ type: "extension_ui_request", id: "t1", method: "confirm", title: "Continue?", timeout: 20 }, { type: "agent_settled" }]]);
    // Nobody answers: the card settles on Pi's own timeout.
    const events = await collect(createPiAgent(pi.spawn)(CONFIG, request()));
    // Frozen as nobody's answer: no reply rides the resolution.
    expect(events.find((event) => event.kind === "resolved")).toEqual({ kind: "resolved", requestId: expect.any(String) });
    expect(uiResponses(pi)).toEqual([]);
});

test("a card waiting on a person holds the silence watchdog, so a slow answer does not time the turn out", async () => {
    const timeouts: TurnTimeouts = { inactivityMs: 30, maxTurnMs: 10_000 };
    const pi = fakePi([[{ type: "extension_ui_request", id: "c1", method: "confirm", title: "Go on?" }]]);
    const events: AgentEvent[] = [];
    for await (const event of createPiAgent(pi.spawn, timeouts)(CONFIG, request())) {
        events.push(event);
        if (event.kind === "question") {
            // Answered well past the silence window; Pi settles a moment after hearing back, inside a fresh one.
            setTimeout(() => {
                cards.resolve({ kind: "question", requestId: event.requestId, answers: { "Go on?": ["No"] } });
                setTimeout(() => pi.emit({ type: "agent_settled" }), 10);
            }, 120);
        }
    }
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(uiResponses(pi)).toEqual([{ type: "extension_ui_response", id: "c1", confirmed: false }]);
});

test("a dialog with malformed fields still reaches a card with what could be read, since Pi is blocked on it", async () => {
    const pi = fakePi([[{ type: "extension_ui_request", id: "x1", method: "select", options: "not a list", title: 7 }, { type: "agent_settled" }]]);
    const events = await collectAnswering(createPiAgent(pi.spawn)(CONFIG, request()), () => ({ cancelled: true }));
    // Its fields fall back rather than failing: an untitled card with no options, which a dismissal cancels.
    expect(events.find((event) => event.kind === "question")).toMatchObject({ questions: [{ question: "", options: [] }] });
    expect(uiResponses(pi)).toEqual([{ type: "extension_ui_response", id: "x1", cancelled: true }]);
});

test("a process death mid-turn surfaces as the turn's error, never a hang", async () => {
    const pi = fakePi([[{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "half a thou" } }]]);
    const turn = collect(createPiAgent(pi.spawn)(CONFIG, request()));
    setTimeout(() => pi.exit(1), 10);
    const events = await turn;
    expect(events.at(-2)).toMatchObject({ kind: "error", message: expect.stringContaining("exited mid-turn") });
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("a rejected prompt surfaces Pi's own reason", async () => {
    const pi = fakePi([], { prompt: { success: false, error: "streamingBehavior required" } });
    const events = await collect(createPiAgent(pi.spawn)(CONFIG, request()));
    expect(events.find((event) => event.kind === "error")).toMatchObject({ message: expect.stringContaining("streamingBehavior required") });
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("a silent agent trips the inactivity watchdog: the process is killed and the turn ends with an error", async () => {
    jest.useFakeTimers();
    try {
        const timeouts: TurnTimeouts = { inactivityMs: 50, maxTurnMs: 10_000 };
        const pi = fakePi([[]]); // prompt accepted, then nothing — ever
        const turn = collect(createPiAgent(pi.spawn, timeouts)(CONFIG, request()));
        await advanceTimersByTimeAsync(200);
        jest.useRealTimers();
        const events = await turn;
        expect(events.find((event) => event.kind === "error")).toMatchObject({ message: expect.stringContaining("timed out") });
        expect(pi.killed()).toBe(true);
    } finally {
        jest.useRealTimers();
    }
});

test("an abort sends Pi's abort and ends the turn without a spurious error", async () => {
    const controller = new AbortController();
    const pi = fakePi([[]], {
        abort: () => {
            // Pi settles the run after an abort, as it does live.
            setTimeout(() => pi.emit({ type: "agent_settled" }), 0);
            return { success: true };
        },
    });
    const turn = collect(createPiAgent(pi.spawn)(CONFIG, request({ signal: controller.signal })));
    setTimeout(() => controller.abort(), 10);
    const events = await turn;
    expect(pi.sent).toContainEqual({ type: "abort" });
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "done" });
});

// Pi answers a prompt only once its preflight (auth, a compaction, an extension's hooks) is through, and starts the run
// right after; its `abort` cannot reach a run that has not started. A prompt nobody waits for any more must not become
// a run nobody reads.
test("a prompt Pi never answers is given up at the deadline: the request is told to stop, and Pi is aborted and killed", async () => {
    jest.useFakeTimers();
    try {
        let promptSignal: AbortSignal | undefined;
        const { promise: prompted, resolve: notePrompt } = Promise.withResolvers<void>();
        const pi = fakePi([], {
            prompt: (_command, signal) => {
                promptSignal = signal;
                notePrompt();
                return new Promise<PiResponse>(() => {});
            },
        });
        const turn = collect(createPiAgent(pi.spawn)(CONFIG, request()));
        await prompted;
        await advanceTimersByTimeAsync(15_000);
        jest.useRealTimers();
        const events = await turn;
        expect(events.find((event) => event.kind === "error")).toMatchObject({ message: expect.stringContaining("did not answer the prompt within 15s") });
        expect(promptSignal?.aborted).toBe(true);
        expect(pi.sent).toContainEqual({ type: "abort" });
        expect(pi.killed()).toBe(true);
        expect(events.at(-1)).toEqual({ kind: "done" });
    } finally {
        jest.useRealTimers();
    }
});

test("a turn stopped while setup is still asking Pi never sends its prompt, and ends without an error", async () => {
    const controller = new AbortController();
    const pi = fakePi([[{ type: "agent_settled" }]], {
        get_state: () => {
            controller.abort();
            return { success: true, data: { sessionFile: SESSION_FILE } };
        },
    });
    const events = await collect(createPiAgent(pi.spawn)(CONFIG, request({ signal: controller.signal })));
    expect(pi.sent.filter((command) => command["type"] === "prompt")).toEqual([]);
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "done" });
});

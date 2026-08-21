import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { AgentRequest } from "../agent/agent.js";
import { resolveRequest } from "../agent/agent-requests.js";
import { SteeringQueue } from "../agent/agent-steering.js";
import { createPiAgent, type PiTimeouts } from "./pi-agent.js";
import type { PiEvent, PiProcessHandlers, PiResponse, PiSpawn } from "./pi-rpc.js";

/* The Pi adapter over a scripted process: no spawn, no binary (the QueryFn/CodexRunner/fake-acp-agent
 * pattern for Pi RPC). The fake answers commands from a response table and scripts what streams after each
 * accepted prompt, so the tests exercise the adapter's real loop: setup, framing, steering, plan phases,
 * watchdogs, and the frames the client actually renders. */

const SESSION_FILE = "/auth/pi/sessions/s1.jsonl";

type Responder = PiResponse | ((command: Record<string, unknown>) => PiResponse);

interface FakePi {
    readonly spawn: PiSpawn;
    // Every command the adapter sent (requests and fire-and-forget alike), in order.
    readonly sent: Record<string, unknown>[];
    readonly emit: (event: PiEvent) => void;
    readonly exit: (code: number | null) => void;
    readonly killed: () => boolean;
}

// `prompts` scripts the event burst that follows each accepted prompt, one entry per prompt in send order
// (the last entry repeats: plan revisions loop). `responses` overrides the defaults per command type.
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
                request: async (command) => {
                    sent.push(command);
                    if (exited) {
                        // The production transport's answer once the process is gone (pi-rpc settleExit).
                        return { success: false, error: "the pi process exited" };
                    }
                    const type = command["type"] as string;
                    const responder = responses[type] ?? defaults[type] ?? { success: false, error: `unscripted command ${type}` };
                    const response = typeof responder === "function" ? responder(command) : responder;
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

const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
    prompt: "add a /ping route",
    cwd: WORKSPACE_ROOT,
    signal: new AbortController().signal,
    ...overrides,
});

const CONFIG = { command: "pi" };

// Collect all frames; `onPlan` schedules a decision for each plan frame AFTER the generator parks on the
// pending-plan bridge (the yield suspends before wait() registers, hence the macrotask).
const collect = async (
    turn: AsyncGenerator<AgentEvent>,
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of turn) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => resolveRequest({ kind: "plan", requestId: event.requestId, ...decision }), 0);
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
    await collect(createPiAgent(pi.spawn)(CONFIG, request({ sessionId: SESSION_FILE })));
    expect(pi.sent[0]).toMatchObject({ type: "switch_session", sessionPath: SESSION_FILE });

    const refusing = fakePi([], { switch_session: { success: false, error: "no such session" } });
    const events = await collect(createPiAgent(refusing.spawn)(CONFIG, request({ sessionId: "/gone.jsonl" })));
    expect(events).toEqual([
        { kind: "error", code: "session-not-found", message: "Pi no longer has this chat's session. Send again to start fresh." },
        { kind: "done" },
    ]);
});

test("a deliberate model pin rides set_model as provider/model-id, and a rejected pin fails the turn honestly", async () => {
    const pi = fakePi();
    await collect(createPiAgent(pi.spawn)(CONFIG, request({ model: "anthropic/claude-sonnet-5" })));
    expect(pi.sent).toContainEqual({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" });

    const refusing = fakePi([], { set_model: { success: false, error: "Model not found" } });
    const events = await collect(createPiAgent(refusing.spawn)(CONFIG, request({ model: "anthropic/claude-nonexistent" })));
    expect(events.map((event) => event.kind)).toEqual(["session", "error", "done"]);
});

test("effort rides set_thinking_level, and a tier the model lacks is tolerated rather than fatal", async () => {
    const pi = fakePi([[{ type: "agent_settled" }]], { set_thinking_level: { success: false, error: "not supported" } });
    const events = await collect(createPiAgent(pi.spawn)(CONFIG, request({ effort: "high" })));
    expect(pi.sent).toContainEqual({ type: "set_thinking_level", level: "high" });
    expect(events.some((event) => event.kind === "error")).toBe(false);
});

test("steering messages are forwarded onto Pi's steer queue mid-turn", async () => {
    const steering = new SteeringQueue();
    // The prompt's script parks the turn until the steer arrives; the steer response releases it.
    const pi = fakePi([[]], {
        steer: (command) => {
            expect(command["message"]).toBe("also add a test");
            // The steer is in: let the turn settle.
            setTimeout(() => pi.emit({ type: "agent_settled" }), 0);
            return { success: true };
        },
    });
    const turn = collect(createPiAgent(pi.spawn)(CONFIG, request({ steering })));
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
    const turn = collect(createPiAgent(pi.spawn)(CONFIG, request({ steering })));
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
    const events = await collect(createPiAgent(pi.spawn)(CONFIG, request({ permissionMode: "plan" })), () => ({ approve: true }));

    const plan = events.find((event) => event.kind === "plan");
    expect(plan).toMatchObject({ text: "1. Add route\n2. Add test" });
    // The plan text never streamed as deltas; the execute phase's narration did.
    expect(events.filter((event) => event.kind === "delta")).toEqual([{ kind: "delta", text: "Done." }]);
    const prompts = pi.sent.filter((command) => command["type"] === "prompt");
    expect(prompts).toHaveLength(2);
    expect(String(prompts[1]?.["message"])).toContain("approved");
});

test("an extension UI dialog is answered (cancelled) so a project-level Pi extension can never hang the turn", async () => {
    const pi = fakePi([
        [
            { type: "extension_ui_request", id: "u1", method: "confirm", title: "Clear session?" },
            { type: "extension_ui_request", id: "u2", method: "notify", message: "fyi" },
            { type: "agent_settled" },
        ],
    ]);
    await collect(createPiAgent(pi.spawn)(CONFIG, request()));
    expect(pi.sent).toContainEqual({ type: "extension_ui_response", id: "u1", cancelled: true });
    // Fire-and-forget methods get no reply.
    expect(pi.sent.filter((command) => command["type"] === "extension_ui_response")).toHaveLength(1);
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
    vi.useFakeTimers();
    try {
        const timeouts: PiTimeouts = { inactivityMs: 50, maxTurnMs: 10_000 };
        const pi = fakePi([[]]); // prompt accepted, then nothing — ever
        const turn = collect(createPiAgent(pi.spawn, timeouts)(CONFIG, request()));
        await vi.advanceTimersByTimeAsync(200);
        vi.useRealTimers();
        const events = await turn;
        expect(events.find((event) => event.kind === "error")).toMatchObject({ message: expect.stringContaining("timed out") });
        expect(pi.killed()).toBe(true);
    } finally {
        vi.useRealTimers();
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

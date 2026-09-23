import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent, TodoItem } from "@intentic/sandbox-contract";
import type { HeldReason, HeldTurn } from "../turn/turn-resume.js";
import type { UsageFrame } from "../turn/turn-usage.js";
import {
    type ContextFrame,
    createTurnFrames,
    foldChecklist,
    foldCompactions,
    foldContext,
    foldFailure,
    foldHeld,
    foldLimitReset,
    foldSession,
    foldSilence,
    foldUsage,
    frameReducer,
    type Silence,
    type TurnFailure,
} from "./frame-reducers.js";

const walk = <Reading>(initial: Reading, fold: (reading: Reading, event: AgentEvent) => Reading, frames: readonly AgentEvent[]): Reading =>
    frames.reduce(fold, initial);

const kinds = (...names: AgentEvent["kind"][]): ReadonlySet<AgentEvent["kind"]> => new Set(names);
const quiet: Silence = { proseChars: 0, kinds: kinds(), answered: false };
const heldAs = (reason: HeldReason): HeldTurn => ({ input: { prompt: "go", conversationId: "c-1" }, reason, ran: false });
const edit: AgentEvent = { kind: "tool_call", id: "e", name: "Edit", category: "edit", status: "completed", locations: [{ path: "/work/a.ts" }] };

describe("each fold reads only its own frames", () => {
    const usages: [string, AgentEvent[], UsageFrame | undefined][] = [
        ["no usage frame leaves no total", [{ kind: "delta", text: "hi" }], undefined],
        ["one usage frame is the total", [{ kind: "usage", costUsd: 0.5 }], { kind: "usage", costUsd: 0.5 }],
        [
            "two are summed field by field, a field present if either side reported it",
            [
                { kind: "usage", costUsd: 0.25, inputTokens: 100, numTurns: 1 },
                { kind: "delta", text: "between" },
                { kind: "usage", costUsd: 0.5, outputTokens: 7, numTurns: 1 },
            ],
            { kind: "usage", costUsd: 0.75, inputTokens: 100, outputTokens: 7, numTurns: 2 },
        ],
    ];
    test.each(usages)("usage: %s", (_case, frames, total) => {
        expect(walk<UsageFrame | undefined>(undefined, foldUsage, frames)).toStrictEqual(total);
    });

    const silences: [string, AgentEvent[], Silence][] = [
        ["nothing at all", [], quiet],
        [
            "prose counts its characters",
            [
                { kind: "delta", text: "four" },
                { kind: "delta", text: "56" },
            ],
            { proseChars: 6, kinds: kinds("delta"), answered: true },
        ],
        ["thinking answers without prose", [{ kind: "thinking", text: "hm" }], { proseChars: 0, kinds: kinds("thinking"), answered: true }],
        [
            "a tool call's update and a session do not answer",
            [
                { kind: "session", sessionId: "s" },
                { kind: "tool_call_update", id: "1", status: "completed" },
            ],
            { proseChars: 0, kinds: kinds("session", "tool_call_update"), answered: false },
        ],
        ["a tool call does", [edit], { proseChars: 0, kinds: kinds("tool_call"), answered: true }],
        [
            "a card is a kind like any other",
            [{ kind: "plan", requestId: "r", text: "1. go" }, { kind: "done" }],
            { proseChars: 0, kinds: kinds("plan", "done"), answered: false },
        ],
    ];
    test.each(silences)("silence: %s", (_case, frames, silence) => {
        expect(walk(quiet, foldSilence, frames)).toStrictEqual(silence);
    });

    test("checklist: the last report wins, and none reported is none kept", () => {
        const first: TodoItem[] = [{ content: "a", status: "pending" }];
        const last: TodoItem[] = [
            { content: "a", status: "completed" },
            { content: "b", status: "in_progress" },
        ];
        expect(walk<readonly TodoItem[] | undefined>(undefined, foldChecklist, [{ kind: "delta", text: "x" }])).toBeUndefined();
        expect(
            walk<readonly TodoItem[] | undefined>(undefined, foldChecklist, [
                { kind: "todos", items: first },
                { kind: "todos", items: last },
            ]),
        ).toStrictEqual(last);
        expect(walk<readonly TodoItem[] | undefined>(undefined, foldChecklist, [{ kind: "todos", items: [] }])).toStrictEqual([]);
    });

    test("compactions: one per compact frame", () => {
        expect(
            walk(0, foldCompactions, [
                { kind: "compact", trigger: "auto" },
                { kind: "delta", text: "x" },
                { kind: "compact", trigger: "manual", preTokens: 10 },
            ]),
        ).toBe(2);
    });

    test("context: the last reading, as the stream sent it", () => {
        expect(
            walk<ContextFrame | undefined>(undefined, foldContext, [
                { kind: "context_usage", tokens: 10, contextWindow: 100 },
                { kind: "context_usage", tokens: 40, contextWindow: 100, cachedAt: 5 },
            ]),
        ).toStrictEqual({ kind: "context_usage", tokens: 40, contextWindow: 100, cachedAt: 5 });
    });

    const failures: [string, AgentEvent[], TurnFailure | undefined][] = [
        ["no failure", [{ kind: "done" }], undefined],
        ["an uncoded one", [{ kind: "error", message: "died" }], { code: undefined, message: "died" }],
        [
            "the last of two",
            [
                { kind: "error", code: "rate_limit", message: "first" },
                { kind: "error", code: "provider-outage", message: "second" },
            ],
            { code: "provider-outage", message: "second" },
        ],
    ];
    test.each(failures)("failure: %s", (_case, frames, failure) => {
        expect(walk<TurnFailure | undefined>(undefined, foldFailure, frames)).toStrictEqual(failure);
    });

    const sessions: [string, string | undefined, AgentEvent[], string][] = [
        ["kept when the stream names none", "resumed", [{ kind: "delta", text: "x" }], "resumed"],
        ["replaced by the stream's own", "resumed", [{ kind: "session", sessionId: "fresh" }], "fresh"],
        ["none until one is named", undefined, [{ kind: "session", sessionId: "fresh" }], "fresh"],
    ];
    test.each(sessions)("session: %s", (_case, resumed, frames, sessionId) => {
        expect(walk(resumed, foldSession, frames)).toBe(sessionId);
    });

    const resets: [string, AgentEvent[], number | undefined][] = [
        ["nothing named", [{ kind: "rate_limit_info", status: "allowed" }], undefined],
        [
            "a later frame naming none keeps the earlier instant",
            [
                { kind: "rate_limit_info", status: "allowed_warning", resetsAt: 1_000 },
                { kind: "rate_limit_info", status: "rejected" },
            ],
            1_000,
        ],
        [
            "a later instant replaces it",
            [
                { kind: "rate_limit_info", status: "allowed", resetsAt: 1_000 },
                { kind: "rate_limit_info", status: "rejected", resetsAt: 2_000 },
            ],
            2_000,
        ],
    ];
    test.each(resets)("limit reset: %s", (_case, frames, resetsAt) => {
        expect(walk<number | undefined>(undefined, foldLimitReset, frames)).toBe(resetsAt);
    });
});

// A limit or an outage the harness rode out is over once the provider answers; every other hold stands.
test.each([
    ["prose rides out a limit", "limit", { kind: "delta", text: "back" }, undefined],
    ["a tool call rides out an outage", "outage", edit, undefined],
    ["a usage frame proves nothing", "limit", { kind: "usage", costUsd: 1 }, "limit"],
    ["a refused credential stays refused", "auth", { kind: "delta", text: "back" }, "auth"],
    ["a stopped turn stays held", "stopped", { kind: "thinking", text: "again" }, "stopped"],
] as const)("held: %s", (_case, reason, event, after) => {
    expect(foldHeld(heldAs(reason), event)?.reason).toBe(after);
});

test("a reducer answers its reading at any point of the walk", () => {
    const count = frameReducer(0, foldCompactions);
    expect(count.reading()).toBe(0);
    count.note({ kind: "compact", trigger: "auto" });
    expect(count.reading()).toBe(1);
});

describe("a turn's frames", () => {
    test("fold into every reading and ledger at once, and say which frame was the first answer", () => {
        const frames = createTurnFrames(WORKSPACE_ROOT, "resumed");
        const stream: AgentEvent[] = [
            { kind: "session", sessionId: "s-1" },
            { kind: "rate_limit_info", status: "allowed", resetsAt: 50 },
            { kind: "delta", text: "hello" },
            edit,
            { kind: "todos", items: [{ content: "a", status: "in_progress" }] },
            { kind: "usage", costUsd: 1 },
            { kind: "compact", trigger: "auto" },
            { kind: "context_usage", tokens: 9, contextWindow: 90 },
            { kind: "error", message: "stopped" },
        ];

        expect(stream.map((event) => frames.note(event))).toStrictEqual([false, false, true, false, false, false, false, false, false]);
        expect(frames.readings()).toStrictEqual({
            sessionId: "s-1",
            usage: { kind: "usage", costUsd: 1 },
            silence: {
                proseChars: 5,
                kinds: kinds("session", "rate_limit_info", "delta", "tool_call", "todos", "usage", "compact", "context_usage", "error"),
                answered: true,
            },
            checklist: [{ content: "a", status: "in_progress" }],
            compactions: 1,
            context: { kind: "context_usage", tokens: 9, contextWindow: 90 },
            failure: { code: undefined, message: "stopped" },
            limitReset: 50,
            held: undefined,
        });
        expect(frames.verification.edited()).toStrictEqual(["/work/a.ts"]);
        expect(frames.viewing.edited()).toStrictEqual([]);
        expect(frames.metrics.calls()).toBe(1);
    });

    test("start on the resumed session, with nothing read yet", () => {
        expect(createTurnFrames(WORKSPACE_ROOT, "resumed").readings()).toStrictEqual({
            sessionId: "resumed",
            usage: undefined,
            silence: quiet,
            checklist: undefined,
            compactions: 0,
            context: undefined,
            failure: undefined,
            limitReset: undefined,
            held: undefined,
        });
    });

    test("take the last classification's hold, which a later answer then rides out", () => {
        const frames = createTurnFrames(WORKSPACE_ROOT, undefined);
        frames.hold(heldAs("stopped"));
        frames.hold(heldAs("limit"));
        expect(frames.readings().held).toStrictEqual(heldAs("limit"));
        frames.note({ kind: "thinking", text: "again" });
        expect(frames.readings().held).toBeUndefined();
    });
});

import { RESUME_NOTES, RETRY_LADDER_TRIES, type TurnBreakPolicy } from "@intentic/sandbox-contract";
import { describe, expect, test } from "bun:test";
import type { LimitWay } from "../../models/limit-way.js";
import { OUTAGE_MAX_ATTEMPTS } from "../../providers/provider-health.js";
import {
    classifyFailure,
    ERROR_MESSAGE_CHARS,
    type ErrorFrame,
    type FailureContext,
    type FailureQueries,
    type FailureWrite,
    holdsAsStopped,
    outageFrame,
} from "./classify-failure.js";

const NOW = 1_800_000_000_000;
// Whatever the turn is attributed to rides its refusal, the actor included.
const attribution = { account: "acct", actor: "ada@example.com" };
const standing = { state: "no-code", paths: [], check: undefined } as const;

// A conversation's turn on a Claude account, as it stood when the frame arrived; each case changes what it is about.
const context = (change: Partial<FailureContext> = {}): FailureContext => ({
    turn: { prompt: "ship it", conversationId: "c-1" },
    turnId: "t-1",
    provider: "claude",
    model: "opus",
    account: "acct",
    attribution,
    sessionId: "s-1",
    answered: true,
    resumeArmed: false,
    limitReset: undefined,
    outage: undefined,
    standing,
    checklist: undefined,
    contextTokens: 9_000,
    now: NOW,
    ...change,
});

// Canned answers to every question, recording each one asked.
const answering = (
    answers: { readonly policy?: TurnBreakPolicy; readonly reopensAt?: number; readonly way?: LimitWay; readonly made?: number; readonly rung?: number } = {},
): FailureQueries & { readonly asked: unknown[][] } => {
    const asked: unknown[][] = [];
    return {
        asked,
        breakPolicy: async (conversationId, ending) => {
            asked.push(["breakPolicy", conversationId, ending]);
            return answers.policy ?? "wait";
        },
        reopensAt: async (at) => {
            asked.push(["reopensAt", at]);
            return answers.reopensAt;
        },
        limitWay: async (params) => {
            asked.push(["limitWay", params]);
            return params.turn.conversationId === undefined ? undefined : answers.way;
        },
        stopLadder: (conversationId) => {
            asked.push(["stopLadder", conversationId]);
            return { made: answers.made ?? 0, nextAt: answers.rung };
        },
    };
};

const way: LimitWay = { standing, contextTokens: 9_000, handoffTokens: 1_200 };
const limit: ErrorFrame = { kind: "error", code: "rate_limit", message: "Claude usage limit reached." };
const died: ErrorFrame = { kind: "error", message: "the harness crashed" };

const refused = (kind: "limit" | "auth" | "entitlement", message: string): FailureWrite[] => [
    { kind: "provider-refusal", provider: "claude", refusal: { at: NOW, kind, message, ...attribution, model: "opus" } },
    { kind: "headroom-refresh", options: { scope: { providers: ["claude"], account: "acct" }, maxAgeMs: 0 } },
];

describe("a spent allowance", () => {
    test("held on its conversation, it names the stream's reset over the frame's own and asks no snapshot", async () => {
        const queries = answering({ way, reopensAt: 5 });
        const plan = await classifyFailure({ ...limit, resetsAt: 7 }, context({ limitReset: 1_900_000_000 }), queries);

        expect(plan).toStrictEqual({
            ending: "limit",
            frame: {
                kind: "error",
                code: "rate_limit",
                message: "Claude usage limit reached.",
                resetsAt: 1_900_000_000,
                held: { ran: true, contextTokens: 9_000, handoffTokens: 1_200 },
                autoResume: "available",
            },
            writes: refused("limit", "Claude usage limit reached."),
            log: {
                level: "warn",
                message: "turn refused",
                fields: {
                    turnId: "t-1",
                    provider: "claude",
                    harness: "native",
                    code: "rate_limit",
                    model: "opus",
                    account: "acct",
                    actor: "ada@example.com",
                    conversationId: "c-1",
                    sessionId: "s-1",
                    reason: "Claude usage limit reached.",
                },
            },
            walls: { limit: { hit: true, reopens: 1_900_000_000, way } },
        });
        expect(queries.asked).toStrictEqual([
            [
                "limitWay",
                {
                    turn: { prompt: "ship it", conversationId: "c-1" },
                    provider: "claude",
                    model: "opus",
                    account: "acct",
                    ran: true,
                    standing,
                    checklist: undefined,
                    contextTokens: 9_000,
                    sessionId: "s-1",
                },
            ],
            ["breakPolicy", "c-1", "limit"],
        ]);
    });

    test("falls back to the frame's own reset, then to the snapshot", async () => {
        expect((await classifyFailure({ ...limit, resetsAt: 7 }, context(), answering({ way, reopensAt: 5 }))).frame.resetsAt).toBe(7);
        expect((await classifyFailure(limit, context(), answering({ way, reopensAt: 5 }))).frame.resetsAt).toBe(5);
    });

    const armed: [string, TurnBreakPolicy, LimitWay, Partial<ErrorFrame>][] = [
        ["an armed conversation keeps the reset as its appointment", "resend", way, { autoResume: "scheduled", nextAt: 60 }],
        ["an unarmed one only offers", "wait", way, { autoResume: "available" }],
        [
            "a booked move is scheduled now, so it names no instant",
            "move",
            { ...way, move: { account: "sibling", carry: false } },
            { autoResume: "scheduled", held: { ran: true, contextTokens: 9_000, handoffTokens: 1_200, moving: "sibling" } },
        ],
    ];
    test.each(armed)("%s", async (_case, policy, booked, dressed) => {
        const { frame } = await classifyFailure(limit, context({ limitReset: 60 }), answering({ policy, way: booked }));
        expect(frame).toStrictEqual({ ...limit, resetsAt: 60, held: { ran: true, contextTokens: 9_000, handoffTokens: 1_200 }, ...dressed });
    });

    test("with no reset anywhere it is still held, with nothing to schedule", async () => {
        const queries = answering({ way });
        const plan = await classifyFailure(limit, context({ answered: false }), queries);
        expect(plan.frame).toStrictEqual({ ...limit, held: { ran: false, contextTokens: 9_000, handoffTokens: 1_200 } });
        expect(plan.walls).toStrictEqual({ limit: { hit: true, reopens: undefined, way } });
        expect(queries.asked.map(([name]) => name)).toStrictEqual(["reopensAt", "limitWay"]);
    });

    test("with no reset and no conversation it goes out bare, and says it held nothing", async () => {
        const turn = { prompt: "ship it" };
        const plan = await classifyFailure(limit, context({ turn }), answering({ way }));
        expect(plan.ending).toBe("bare");
        expect(plan.frame).toBe(limit);
        expect(plan.walls).toStrictEqual({ limit: { hit: false, reopens: undefined, way: undefined } });
        expect(plan.log.fields).toStrictEqual({
            turnId: "t-1",
            provider: "claude",
            harness: "native",
            code: "rate_limit",
            model: "opus",
            account: "acct",
            actor: "ada@example.com",
            sessionId: "s-1",
            reason: "Claude usage limit reached.",
        });
    });

    test("on a routed provider benches the model to the resolved reset, in epoch milliseconds", async () => {
        const plan = await classifyFailure(
            { ...limit, message: "429 usage limit" },
            context({ provider: "codex", model: "gpt-5.1", account: undefined, attribution: {}, limitReset: 1_900_000_000 }),
            answering({ way }),
        );
        expect(plan.writes).toStrictEqual([
            { kind: "provider-refusal", provider: "codex", refusal: { at: NOW, kind: "limit", message: "429 usage limit", model: "gpt-5.1" } },
            { kind: "headroom-refresh", options: { scope: { providers: ["codex"] }, maxAgeMs: 0 } },
            { kind: "model-cooldown", provider: "codex", model: "gpt-5.1", cooldown: { until: 1_900_000_000_000, message: "429 usage limit" } },
        ]);
    });

    test("on a routed provider with no reset benches nothing", async () => {
        const plan = await classifyFailure(limit, context({ provider: "codex", model: "gpt-5.1", account: undefined, attribution: {} }), answering({ way }));
        expect(plan.writes.map(({ kind }) => kind)).toStrictEqual(["provider-refusal", "headroom-refresh"]);
    });

    test("on a plan with nothing to poll files the refusal as the account's reading of that model", async () => {
        const plan = await classifyFailure(limit, context({ provider: "cursor", model: "composer-2.5", attribution: { account: "acct" } }), answering({ way }));
        expect(plan.writes).toStrictEqual([
            { kind: "provider-refusal", provider: "cursor", refusal: { at: NOW, kind: "limit", message: "Claude usage limit reached.", account: "acct", model: "composer-2.5" } },
            { kind: "headroom-refresh", options: { scope: { providers: ["cursor"], account: "acct" }, maxAgeMs: 0 } },
            { kind: "observed-limit", provider: "cursor", account: "acct", model: "composer-2.5", limit: { at: NOW, message: "Claude usage limit reached." } },
        ]);
    });

    test.each([
        ["no account", { account: undefined }],
        ["no model", { model: undefined }],
        ["the catalog default", { model: "" }],
    ] as const)("on such a plan with %s files no reading", async (_case, change) => {
        const plan = await classifyFailure(limit, context({ provider: "cursor", ...change }), answering({ way }));
        expect(plan.writes.map(({ kind }) => kind)).toStrictEqual(["provider-refusal", "headroom-refresh"]);
    });
});

describe("an outage", () => {
    test("within the attempt budget is the breaker's retry frame, offered", async () => {
        const plan = await classifyFailure(
            { kind: "error", code: "provider-outage", message: "overloaded" },
            context({ outage: { attempt: 0, retryAt: 1_800_000_030_400 } }),
            answering(),
        );
        expect(plan.ending).toBe("outage");
        expect(plan.frame).toStrictEqual({
            kind: "error",
            code: "provider-outage",
            message: "overloaded",
            autoResume: "available",
            outage: { retryAt: 1_800_000_030 },
            retries: { made: 0, max: OUTAGE_MAX_ATTEMPTS },
        });
        expect(plan.writes).toStrictEqual([]);
        expect(plan.walls).toStrictEqual({ outageHit: true });
        expect(plan.log.level).toBe("warn");
    });

    test("on a conversation armed to retry names the breaker's own clock", () => {
        expect(outageFrame({ kind: "error", code: "provider-outage", message: "overloaded" }, true, { attempt: 2, retryAt: 1_800_000_030_600 })).toStrictEqual({
            kind: "error",
            code: "provider-outage",
            message: "overloaded",
            autoResume: "scheduled",
            nextAt: 1_800_000_031,
            outage: { retryAt: 1_800_000_031 },
            retries: { made: 2, max: OUTAGE_MAX_ATTEMPTS },
        });
    });

    test("past the budget goes out bare and holds nothing", async () => {
        const outage = { kind: "error", code: "provider-outage", message: "overloaded" } as const;
        const plan = await classifyFailure(outage, context({ outage: { attempt: OUTAGE_MAX_ATTEMPTS, retryAt: NOW } }), answering());
        expect(plan.ending).toBe("bare");
        expect(plan.frame).toBe(outage);
        expect(plan.walls).toStrictEqual({});
    });
});

describe("a refused credential", () => {
    const token: ErrorFrame = { kind: "error", code: "claude-token-refused", message: "401 invalid bearer token" };

    test("is promised a re-mint when the turn can be resumed", async () => {
        const plan = await classifyFailure(token, context({ resumeArmed: true }), answering());
        expect(plan).toMatchObject({ ending: "auto-resume", frame: { ...token, autoResume: "scheduled" }, walls: { authRefused: true } });
        expect(plan.writes).toStrictEqual(refused("auth", "401 invalid bearer token"));
    });

    test("goes out bare when it cannot be, still marked refused", async () => {
        const plan = await classifyFailure(token, context(), answering());
        expect(plan.ending).toBe("bare");
        expect(plan.frame).toBe(token);
        expect(plan.walls).toStrictEqual({ authRefused: true });
    });

    test("that reads as a spent allowance is filed as one", async () => {
        const spent = { ...token, message: "You've hit your usage limit" };
        expect((await classifyFailure(spent, context(), answering())).writes).toStrictEqual(refused("limit", "You've hit your usage limit"));
    });
});

test("a switched-off seat is filed against the account, after the provider's refusal", async () => {
    const seat: ErrorFrame = { kind: "error", code: "claude-not-entitled", message: "not enabled" };
    const plan = await classifyFailure(seat, context(), answering());
    expect(plan.ending).toBe("bare");
    expect(plan.writes).toStrictEqual([...refused("entitlement", "not enabled"), { kind: "seat-refusal", account: "acct", reason: "not enabled" }]);
    expect((await classifyFailure(seat, context({ account: undefined }), answering())).writes.map(({ kind }) => kind)).toStrictEqual([
        "provider-refusal",
        "headroom-refresh",
    ]);
});

const unavailable: [string, string | undefined, FailureWrite[]][] = [
    ["the named model is filed", "opus", [{ kind: "model-refusal", provider: "claude", model: "opus", refusal: { at: NOW, message: "not on your plan" } }]],
    ["no model files nothing", undefined, []],
    ["the catalog default files nothing", "", []],
];
test.each(unavailable)("a model the plan does not cover: %s", async (_case, model, writes) => {
    const plan = await classifyFailure({ kind: "error", code: "model-unavailable", message: "not on your plan" }, context({ model }), answering());
    expect(plan.writes).toStrictEqual(writes);
    expect(plan.log.level).toBe("warn");
});

describe("an uncoded death", () => {
    test("after an answer is held as stopped, offered when the conversation waits", async () => {
        const queries = answering();
        const plan = await classifyFailure(died, context(), queries);
        expect(plan).toStrictEqual({
            ending: "stopped",
            frame: { ...died, held: { ran: true, contextTokens: 9_000 }, autoResume: "available" },
            writes: [],
            log: {
                level: "error",
                message: "turn failed",
                fields: {
                    turnId: "t-1",
                    provider: "claude",
                    harness: "native",
                    model: "opus",
                    account: "acct",
                    actor: "ada@example.com",
                    conversationId: "c-1",
                    sessionId: "s-1",
                    reason: "the harness crashed",
                },
            },
            walls: {},
        });
        expect(queries.asked).toStrictEqual([
            ["breakPolicy", "c-1", "stopped"],
            ["stopLadder", "c-1"],
        ]);
    });

    test("on a conversation that retries names the ladder's next rung, in epoch seconds, and which try it is", async () => {
        const plan = await classifyFailure(died, context({ contextTokens: undefined }), answering({ policy: "retry", made: 1, rung: 1_800_000_060_500 }));
        expect(plan.frame).toStrictEqual({
            ...died,
            held: { ran: true },
            autoResume: "scheduled",
            nextAt: 1_800_000_061,
            retries: { made: 1, max: RETRY_LADDER_TRIES },
        });
    });

    test("with a spent ladder offers the press instead, and says the ladder is spent", async () => {
        const plan = await classifyFailure(died, context(), answering({ policy: "retry", made: RETRY_LADDER_TRIES }));
        expect(plan.frame).toStrictEqual({
            ...died,
            held: { ran: true, contextTokens: 9_000 },
            autoResume: "available",
            retries: { made: RETRY_LADDER_TRIES, max: RETRY_LADDER_TRIES },
        });
    });

    test("still counts the rungs already sent once the conversation stops retrying", async () => {
        const plan = await classifyFailure(died, context(), answering({ made: 2 }));
        expect(plan.frame).toStrictEqual({
            ...died,
            held: { ran: true, contextTokens: 9_000 },
            autoResume: "available",
            retries: { made: 2, max: RETRY_LADDER_TRIES },
        });
    });

    test.each([
        ["without a conversation", { turn: { prompt: "ship it" } }],
        ["on a stopped resume the provider never answered", { answered: false, turn: { prompt: `${RESUME_NOTES.stopped}\n\nship it`, conversationId: "c-1" } }],
    ] as const)("goes out bare %s", async (_case, change) => {
        const plan = await classifyFailure(died, context(change), answering());
        expect(plan.ending).toBe("bare");
        expect(plan.frame).toBe(died);
    });

    test("never answered on an ordinary message is still held, as not having run", async () => {
        expect((await classifyFailure(died, context({ answered: false }), answering())).frame).toStrictEqual({
            ...died,
            held: { ran: false, contextTokens: 9_000 },
            autoResume: "available",
        });
    });
});

test("a coded failure with a remedy of its own is logged as a failure and goes out bare", async () => {
    const coded: ErrorFrame = { kind: "error", code: "context-window-too-small", message: "too small" };
    const plan = await classifyFailure(coded, context({ sessionId: undefined, model: undefined, attribution: {} }), answering());
    expect(plan).toStrictEqual({
        ending: "bare",
        frame: coded,
        writes: [],
        log: {
            level: "error",
            message: "turn failed",
            fields: { turnId: "t-1", provider: "claude", harness: "native", code: "context-window-too-small", conversationId: "c-1", reason: "too small" },
        },
        walls: {},
    });
});

test("the log keeps a failure's sentence to its first stretch", async () => {
    const long: ErrorFrame = { kind: "error", message: "x".repeat(ERROR_MESSAGE_CHARS + 50) };
    expect((await classifyFailure(long, context({ turn: { prompt: "p" } }), answering())).log.fields["reason"]).toBe("x".repeat(ERROR_MESSAGE_CHARS));
});

test.each([
    ["an uncoded death after an answer", "go", true, { code: undefined }, true],
    ["one before any answer", "go", false, { code: undefined }, true],
    ["a stopped resume never answered", `${RESUME_NOTES.stopped} go`, false, { code: undefined }, false],
    ["a stopped resume that answered", `${RESUME_NOTES.stopped} go`, true, { code: undefined }, true],
    ["a coded failure", "go", true, { code: "rate_limit" }, false],
    ["no failure", "go", true, undefined, false],
] as const)("holds as stopped: %s", (_case, prompt, answered, failure, holds) => {
    expect(holdsAsStopped(prompt, answered, failure)).toBe(holds);
});

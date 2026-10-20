import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AccountUsage, ProviderRefusal, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { opt } from "../../../opt.js";
import { recordingLogger } from "../../../harness/route-fakes.testing.js";
import { recordingTurnStores, services } from "../../../harness/route-services.testing.js";
import { beginTurn } from "../../../conversations/actor/conversation-actors.testing.js";
import { providerOutage, recordProviderFailure, recordProviderSuccess } from "../../providers/provider-health.js";
import type { FailureWrite } from "./classify-failure.js";
import { beginPulse, endPulse } from "../turn/turn-pulse.js";
import {
    activityOf,
    fileAccountUsage,
    performFailureWrites,
    providerAnswered,
    recordFrame,
    type TurnActivity,
    turnActivity,
} from "./frame-effects.js";

afterEach(() => recordProviderSuccess("effects-provider"));

// The turn's stores, recording, over the harness's services; `extra` replaces whole seams a case is about.
const recorded = (extra: Parameters<typeof services>[0] = {}) => {
    const stores = recordingTurnStores();
    const { lines, logger } = recordingLogger();
    return { deps: services({ ...stores.overrides, logger, ...extra }), writes: stores.writes, lines };
};

const warnings = (lines: readonly Record<string, unknown>[]): unknown[] =>
    lines.filter((line) => line["level"] === "warn").map((line) => line["message"]);

const rejecting = async (): Promise<never> => {
    throw new Error("disk full");
};

const windows: UsageWindow[] = [{ kind: "five_hour", utilization: 42, gates: "all" }];
const origin = { automationId: "nightly", provider: "schedule" };

describe("a frame's own row", () => {
    const rows: [string, AgentEvent, ReturnType<typeof activityOf>][] = [
        ["a plan it showed", { kind: "plan", requestId: "r-1", text: "1. go" }, { type: "turn.plan", content: "1. go", extra: { requestId: "r-1" } }],
        ["a failure it hit", { kind: "error", code: "rate_limit", message: "spent" }, { type: "turn.error", outcome: "error", error: "spent" }],
        ["nothing for prose", { kind: "delta", text: "x" }, undefined],
        ["nothing for a question", { kind: "question", requestId: "q", questions: [] }, undefined],
    ];
    test.each(rows)("%s", (_case, event, row) => {
        expect(activityOf(event)).toStrictEqual(row);
    });
});

describe("a frame's writes", () => {
    test("file the reading it carried and write no row for it", async () => {
        const { deps, writes } = recorded();
        const rows: TurnActivity[] = [];
        recordFrame(deps, { kind: "account_usage", windows }, { provider: "claude", account: "acct", record: (row) => void rows.push(row) });
        await waitFor(() => expect(writes.headroomRecords).toHaveLength(1), SETTLES);
        expect(writes.headroomRecords).toStrictEqual([{ provider: "claude", account: "acct", usage: { windows, measuredAt: expect.any(Number) } }]);
        expect(rows).toStrictEqual([]);
    });

    test("write the frame's own row, and file nothing for it", () => {
        const { deps, writes } = recorded();
        const rows: TurnActivity[] = [];
        const turn = { provider: "claude", account: "acct", record: (row: TurnActivity) => void rows.push(row) };
        recordFrame(deps, { kind: "plan", requestId: "r-1", text: "1. go" }, turn);
        recordFrame(deps, { kind: "delta", text: "no row" }, turn);
        expect(rows).toStrictEqual([{ type: "turn.plan", content: "1. go", extra: { requestId: "r-1" } }]);
        expect(writes.headroomRecords).toStrictEqual([]);
    });
});

describe("the turn's rows", () => {
    test("carry the turn's identity, the title as it stands at each row, and the session once there is one", async () => {
        const { deps, writes } = recorded();
        await beginTurn(
            deps.conversations,
            { conversationId: "effects-rows", isolated: false, prompt: "ship it", profile: { agent: "claude", harness: "native" } },
            1,
        );
        // The sessions the stream has named so far; the row reads the latest.
        const sessions: string[] = [];
        const record = turnActivity(deps, {
            input: { prompt: "ship it", conversationId: "effects-rows", origin },
            provider: "claude",
            turnId: "t-1",
            attribution: { account: "acct", actor: "ada@example.com" },
            sessionId: () => sessions.at(-1),
        });

        record({ type: "turn.started", content: "ship it" });
        sessions.push("s-1");
        await deps.agents.setTitle("effects-rows", "Renamed", "user");
        record({ type: "turn.completed" });

        const identity = {
            provider: "claude",
            direction: "system" as const,
            turnId: "t-1",
            account: "acct",
            actor: "ada@example.com",
            conversationId: "effects-rows",
        };
        expect(writes.activity).toStrictEqual([
            { ...identity, title: "Ship it", origin, type: "turn.started", content: "ship it" },
            { ...identity, sessionId: "s-1", title: "Renamed", origin, type: "turn.completed" },
        ]);
    });

    test("of a turn with no conversation name none, and a refused append is logged, not thrown", async () => {
        const { deps, lines } = recorded({ activity: { append: rejecting, list: async () => [] } });
        turnActivity(deps, { input: { prompt: "p" }, provider: "codex", turnId: "t-2", attribution: {}, sessionId: () => undefined })({
            type: "turn.started",
        });
        await waitFor(() => expect(warnings(lines)).toStrictEqual(["activity: turn event append failed"]), SETTLES);
    });
});

describe("the first answer", () => {
    test("ends the provider's outage and settles what the provider and the seat last refused", () => {
        const { deps, writes } = recorded();
        recordProviderFailure("effects-provider");
        providerAnswered(deps, "effects-provider", "acct", undefined);
        expect(providerOutage("effects-provider")).toBeUndefined();
        expect(writes.refusalsCleared).toStrictEqual([{ provider: "effects-provider", account: "acct" }]);
        expect(writes.seatsCleared).toStrictEqual(["acct"]);
    });

    test("with no account settles the provider alone", () => {
        const { deps, writes } = recorded();
        providerAnswered(deps, "codex", undefined, undefined);
        expect(writes.refusalsCleared).toStrictEqual([{ provider: "codex", account: undefined }]);
        expect(writes.seatsCleared).toStrictEqual([]);
    });

    test("reopens the model it ran on, so a benched row stops reading as one", () => {
        const { deps, writes } = recorded();
        providerAnswered(deps, "codex", undefined, "gpt-6-astra");
        expect(writes.cooldownsCleared).toStrictEqual([{ provider: "codex", model: "gpt-6-astra" }]);
    });

    // A spent allowance is about one model, so the settle says which one answered (provider-refusals.ts answeredBy).
    test("settles what was refused for the model that answered, and the account's own refusals in the ledger", async () => {
        const { deps, writes } = recorded();
        providerAnswered(deps, "cursor", "acct", "composer-2.5");
        expect(writes.refusalsCleared).toStrictEqual([{ provider: "cursor", account: "acct", model: "composer-2.5" }]);
        await waitFor(
            () =>
                expect(writes.observedForgotten).toStrictEqual([
                    { provider: "cursor", account: "acct", model: "*" },
                    { provider: "cursor", account: "acct", model: "composer-2.5" },
                ]),
            SETTLES,
        );
    });

    test("with no model named reopens nothing", () => {
        const { deps, writes } = recorded();
        providerAnswered(deps, "codex", undefined, "");
        expect(writes.cooldownsCleared).toStrictEqual([]);
    });

    test("logs each settle that fails under its own name", async () => {
        const base = services();
        const { deps, lines } = recorded({
            providerRefusals: { ...base.providerRefusals, clear: rejecting },
            claudeSeats: { ...base.claudeSeats, clear: rejecting },
        });
        providerAnswered(deps, "claude", "acct", undefined);
        await waitFor(
            () => expect(warnings(lines)).toStrictEqual(["provider refusal: settle failed", "claude account: could not clear the entitlement mark"]),
            SETTLES,
        );
    });
});

// What the provider's accounts read and what stands refused and benched on them, over the recording stores.
const onFile = (readings: Record<string, AccountUsage>, refused: readonly ProviderRefusal[], benched: readonly string[]) => {
    const stores = recordingTurnStores();
    const { providerRefusals, modelCooldowns, headroom } = stores.overrides;
    if (providerRefusals === undefined || modelCooldowns === undefined || headroom === undefined) {
        throw new Error("the recording stores carry every one of these");
    }
    const provider = refused[0]?.account === undefined ? "codex" : "claude";
    const deps = services({
        ...stores.overrides,
        providerRefusals: { ...providerRefusals, onFile: async () => ({ [provider]: [...refused] }) },
        modelCooldowns: { ...modelCooldowns, cooling: async () => new Map(benched.map((model) => [model, { until: Date.now() + 3_600_000, message: "spent", since: 1 }])) },
        headroom: { ...headroom, read: async () => readings },
    });
    return { deps, writes: stores.writes };
};

const pool = (kind: string, gates: UsageWindow["gates"] = "all"): UsageWindow => ({ kind, utilization: 0, gates });
const spentOn = (model: string, account?: string): ProviderRefusal => ({ at: 1, kind: "limit", message: "spent", model, ...opt("account", account) });

describe("an answer on a model that shares its allowance", () => {
    // 2026-10-20: a Luna turn went through while Sol stayed refused and benched for another hour over the same allowance.
    test("settles another model's refusal and bench where every pool it spends gates the model that answered", async () => {
        const { deps, writes } = onFile(
            {
                "codex:codex-team.json": { windows: [pool("five_hour"), pool("seven_day")], measuredAt: 1 },
                "codex:codex-free.json": { windows: [pool("monthly")], measuredAt: 1 },
            },
            [spentOn("gpt-6.1-sol")],
            ["gpt-6.1-sol"],
        );
        // A routed turn names its subscription's label, the key of no reading: every reading of the provider speaks.
        providerAnswered(deps, "codex", "codex-subscription", "gpt-6-luna", 2);
        await waitFor(() => expect(writes.cooldownsCleared).toContainEqual({ provider: "codex", model: "gpt-6.1-sol", askedAt: 2 }), SETTLES);
        expect(writes.refusalsCleared).toContainEqual({ provider: "codex", account: "codex-subscription", model: "gpt-6.1-sol", askedAt: 2 });
    });

    test("leaves a model alone where any pool it spends is its own", async () => {
        const plan = { windows: [pool("five_hour"), pool("seven_day"), pool("model:Opus", { models: ["Opus"] })], measuredAt: 1 };
        const { deps, writes } = onFile({ acct: plan }, [spentOn("claude-sonnet-4-6", "acct"), spentOn("claude-opus-4-6", "acct")], []);
        providerAnswered(deps, "claude", "acct", "claude-haiku-4-5", 2);
        await waitFor(() => expect(writes.refusalsCleared).toContainEqual({ provider: "claude", account: "acct", model: "claude-sonnet-4-6", askedAt: 2 }), SETTLES);
        expect(writes.refusalsCleared.map((entry) => entry.model)).not.toContain("claude-opus-4-6");
    });

    test("settles nothing more where a routed provider's readings disagree, or nothing is read", async () => {
        const entitled = { windows: [pool("monthly"), pool("entitlement:gpt-6.1-sol", { models: ["gpt-6.1-sol"] })], measuredAt: 1 };
        const split = onFile({ "codex:codex-team.json": { windows: [pool("five_hour")], measuredAt: 1 }, "codex:codex-free.json": entitled }, [spentOn("gpt-6.1-sol")], ["gpt-6.1-sol"]);
        providerAnswered(split.deps, "codex", "codex-subscription", "gpt-6-luna", 2);
        const unread = onFile({}, [spentOn("gpt-6.1-sol")], ["gpt-6.1-sol"]);
        providerAnswered(unread.deps, "codex", "codex-subscription", "gpt-6-luna", 2);
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const { writes } of [split, unread]) {
            expect(writes.cooldownsCleared).toStrictEqual([{ provider: "codex", model: "gpt-6-luna", askedAt: 2 }]);
            expect(writes.refusalsCleared).toStrictEqual([{ provider: "codex", account: "codex-subscription", model: "gpt-6-luna", askedAt: 2 }]);
        }
    });
});

describe("an account reading", () => {
    test("on a native provider is filed under the account that served", async () => {
        const { deps, writes } = recorded();
        await fileAccountUsage(deps, "claude", "acct", windows);
        expect(writes.headroomRecords).toStrictEqual([{ provider: "claude", account: "acct", usage: { windows, measuredAt: expect.any(Number) } }]);
        expect(writes.headroomRefreshes).toStrictEqual([]);
    });

    test("on a native provider with no account is filed nowhere", async () => {
        const { deps, writes } = recorded();
        await fileAccountUsage(deps, "claude", undefined, windows);
        expect(writes.headroomRecords).toStrictEqual([]);
        expect(writes.headroomRefreshes).toStrictEqual([]);
    });

    test("on a routed provider goes under the subscription's shared key", async () => {
        const { deps, writes } = recorded({ cliProxy: { sharedUsageKey: async () => "codex-shared" } });
        await fileAccountUsage(deps, "codex", "ignored", windows);
        expect(writes.headroomRecords).toStrictEqual([
            { provider: "codex", account: "codex-shared", usage: { windows, measuredAt: expect.any(Number) } },
        ]);
    });

    test("on a routed provider with no shared key re-reads every file instead", async () => {
        const { deps, writes } = recorded();
        await fileAccountUsage(deps, "codex", undefined, windows);
        expect(writes.headroomRefreshes).toStrictEqual([{ scope: { providers: ["codex"] }, maxAgeMs: 0 }]);
        expect(writes.headroomRecords).toStrictEqual([]);
    });

    test("that cannot be written is logged, not thrown", async () => {
        const { deps, lines } = recorded({ cliProxy: { sharedUsageKey: rejecting } });
        await fileAccountUsage(deps, "codex", undefined, windows);
        expect(warnings(lines)).toStrictEqual(["account usage: snapshot write failed"]);
    });
});

describe("a classification's writes", () => {
    const all: FailureWrite[] = [
        { kind: "provider-refusal", provider: "cursor", refusal: { at: 1, kind: "limit", message: "spent", account: "acct", model: "m" } },
        { kind: "headroom-refresh", options: { scope: { providers: ["cursor"], account: "acct" }, maxAgeMs: 0 } },
        { kind: "observed-limit", provider: "cursor", account: "acct", model: "m", limit: { at: 1, message: "spent" } },
        { kind: "model-refusal", provider: "cursor", model: "m", refusal: { at: 1, message: "not covered" } },
        { kind: "seat-refusal", account: "acct", reason: "switched off" },
        { kind: "model-cooldown", provider: "grok", model: "grok-4", cooldown: { until: 9_000, message: "spent" } },
    ];

    test("each reach their own store, and a filed reading is re-read at once", async () => {
        const { deps, writes } = recorded();
        performFailureWrites(deps, all);
        await waitFor(() => expect(writes.headroomRefreshes).toHaveLength(2), SETTLES);
        expect(writes.providerRefusals).toStrictEqual([
            { provider: "cursor", refusal: { at: 1, kind: "limit", message: "spent", account: "acct", model: "m" } },
        ]);
        expect(writes.headroomRefreshes).toStrictEqual([
            { scope: { providers: ["cursor"], account: "acct" }, maxAgeMs: 0 },
            { scope: { providers: ["cursor"], account: "acct" }, maxAgeMs: 0 },
        ]);
        expect(writes.observedLimits).toStrictEqual([{ provider: "cursor", account: "acct", model: "m", limit: { at: 1, message: "spent" } }]);
        expect(writes.modelRefusals).toStrictEqual([{ provider: "cursor", model: "m", refusal: { at: 1, message: "not covered" } }]);
        expect(writes.seatsRefused).toStrictEqual([{ account: "acct", reason: "switched off" }]);
        expect(writes.modelCooldowns).toStrictEqual([{ provider: "grok", model: "grok-4", cooldown: { until: 9_000, message: "spent" } }]);
    });

    test("that fail are each logged under their own name, and a failed reading is never re-read", async () => {
        const base = services();
        const { deps, writes, lines } = recorded({
            providerRefusals: { ...base.providerRefusals, record: rejecting },
            observedLimits: { spent: async () => ({}), record: rejecting, clear: async () => {}, forget: async () => false },
            modelRefusals: { refused: async () => new Set(), record: rejecting },
            claudeSeats: { ...base.claudeSeats, refuse: rejecting },
            modelCooldowns: { cooling: async () => new Map(), record: rejecting, clear: async () => {} },
        });
        performFailureWrites(deps, all);
        await waitFor(() => expect(warnings(lines)).toHaveLength(5), SETTLES);
        expect(warnings(lines)).toStrictEqual([
            "provider refusal: write failed",
            "model refusal: write failed",
            "claude account: could not record the entitlement refusal",
            "model cooldown: write failed",
            "observed limit: write failed",
        ]);
        expect(writes.headroomRefreshes).toStrictEqual([{ scope: { providers: ["cursor"], account: "acct" }, maxAgeMs: 0 }]);
    });
});

// A spent allowance's refusal is also the moment its window ran out: what the next spawn listing quotes beside the figure.
describe("a spent allowance's refusal", () => {
    test("notes when the window ran out and the agents running on the provider then", async () => {
        const recordedRunOuts: { provider: string; runOut: unknown }[] = [];
        const { deps } = recorded({
            runOuts: { read: async () => ({}), record: async (provider, runOut) => void recordedRunOuts.push({ provider, runOut }) },
        });
        beginPulse({ conversationId: "runout-child", turnId: "t-1", provider: "codex", harness: "native", model: "gpt-6.1-sol", startedAt: 1 });
        try {
            performFailureWrites(deps, [{ kind: "provider-refusal", provider: "codex", refusal: { at: 5, kind: "limit", message: "spent", model: "gpt-6.1-sol" } }]);
            await waitFor(() => expect(recordedRunOuts).toHaveLength(1), SETTLES);
            expect(recordedRunOuts).toStrictEqual([{ provider: "codex", runOut: { at: 5, models: { "gpt-6.1-sol": 1 } } }]);
        } finally {
            endPulse("runout-child", "t-1");
        }
    });

    test("notes nothing for a refused credential", async () => {
        const recordedRunOuts: unknown[] = [];
        const { deps } = recorded({ runOuts: { read: async () => ({}), record: async (_provider, runOut) => void recordedRunOuts.push(runOut) } });
        performFailureWrites(deps, [{ kind: "provider-refusal", provider: "claude", refusal: { at: 5, kind: "auth", message: "revoked", account: "acct" } }]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(recordedRunOuts).toStrictEqual([]);
    });
});

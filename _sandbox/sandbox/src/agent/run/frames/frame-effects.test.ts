import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AccountUsage, ProviderRefusal, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { opt } from "../../../opt.js";
import { memoryProviderRefusalStore } from "../../../usage/provider-refusals.js";
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
    test("ends the provider's outage and settles what the provider and the seat last refused", async () => {
        const { deps, writes } = recorded();
        recordProviderFailure("effects-provider");
        providerAnswered(deps, "effects-provider", "acct", undefined);
        expect(providerOutage("effects-provider")).toBeUndefined();
        await waitFor(() => expect(writes.refusalsCleared).toStrictEqual([{ provider: "effects-provider", account: "acct" }]), SETTLES);
        expect(writes.seatsCleared).toStrictEqual(["acct"]);
    });

    test("with no account settles the provider alone", async () => {
        const { deps, writes } = recorded();
        providerAnswered(deps, "codex", undefined, undefined);
        await waitFor(() => expect(writes.refusalsCleared).toStrictEqual([{ provider: "codex", account: undefined }]), SETTLES);
        expect(writes.seatsCleared).toStrictEqual([]);
    });

    // 2026-10-09 (rich-alder): GPT-6-Astra stayed greyed while its turns went through, held by a bench only the picker
    // read. The answer settles the model's refusal in the one ledger every surface reads.
    test("reopens the model it ran on, so a refused row stops reading as one", async () => {
        const { deps, ledger } = await onFile({}, "codex", [spentOn("gpt-6-astra")]);
        providerAnswered(deps, "codex", undefined, "gpt-6-astra", ASKED);
        await waitFor(async () => expect(await ledger.onFile()).toEqual({}), SETTLES);
    });

    // A spent allowance is about one model, so the settle says which one answered (provider-refusals.ts settledBy); an
    // account refused outright is settled by an answer on any model.
    test("settles what was refused for the model that answered, and the account refused outright", async () => {
        const forbidden: ProviderRefusal = { at: FILED, kind: "entitlement", message: "[role_forbidden]", account: "acct" };
        const opus = spentOn("claude-opus-5-5", "acct");
        const { deps, ledger } = await onFile({}, "cursor", [forbidden, spentOn("composer-2.5", "acct"), opus]);
        providerAnswered(deps, "cursor", "acct", "composer-2.5", ASKED);
        await waitFor(async () => expect(await ledger.onFile()).toEqual({ cursor: [opus] }), SETTLES);
    });

    test("with no model named leaves a model's spent allowance standing", async () => {
        const sol = spentOn("gpt-6.1-sol");
        const { deps, ledger } = await onFile({}, "codex", [sol]);
        providerAnswered(deps, "codex", undefined, "", ASKED);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await ledger.onFile()).toEqual({ codex: [sol] });
    });

    test("logs each settle that fails under its own name", async () => {
        const base = services();
        const { deps, lines } = recorded({
            providerRefusals: { ...base.providerRefusals, settle: rejecting },
            claudeSeats: { ...base.claudeSeats, clear: rejecting },
        });
        providerAnswered(deps, "claude", "acct", undefined);
        await waitFor(
            () =>
                expect(warnings(lines).toSorted()).toStrictEqual(["claude account: could not clear the entitlement mark", "provider refusal: settle failed"]),
            SETTLES,
        );
    });
});

// What the provider's accounts read, over the real refusal ledger seeded with what stands refused on them.
const onFile = async (readings: Record<string, AccountUsage>, provider: string, refused: readonly ProviderRefusal[]) => {
    const stores = recordingTurnStores();
    const { headroom } = stores.overrides;
    if (headroom === undefined) {
        throw new Error("the recording stores carry a headroom");
    }
    const ledger = memoryProviderRefusalStore({ [provider]: refused });
    const deps = services({ ...stores.overrides, providerRefusals: ledger, headroom: { ...headroom, read: async () => readings } });
    return { deps, ledger };
};

const pool = (kind: string, gates: UsageWindow["gates"] = "all"): UsageWindow => ({ kind, utilization: 0, gates });
// Filed a minute ago, and answered by a request sent now: what was filed before the request went out is what it settles.
const FILED = Date.now() - 60_000;
const ASKED = Date.now();
const spentOn = (model: string, account?: string): ProviderRefusal => ({ at: FILED, kind: "limit", message: "spent", model, ...opt("account", account) });

describe("an answer on a model that shares its allowance", () => {
    // 2026-10-20 (kind-cove): a Luna turn went through while Sol stayed refused and benched for another hour over the same
    // allowance, and the account rail read every Codex account spent over it.
    test("settles another model's refusal where every pool it spends gates the model that answered", async () => {
        const { deps, ledger } = await onFile(
            {
                "codex:codex-team.json": { windows: [pool("five_hour"), pool("seven_day")], measuredAt: 1 },
                "codex:codex-free.json": { windows: [pool("monthly")], measuredAt: 1 },
            },
            "codex",
            [spentOn("gpt-6.1-sol")],
        );
        // A routed turn names its subscription's label, the key of no reading: every reading of the provider speaks.
        providerAnswered(deps, "codex", "codex-subscription", "gpt-6-luna", ASKED);
        await waitFor(async () => expect(await ledger.onFile()).toEqual({}), SETTLES);
    });

    test("leaves a model alone where any pool it spends is its own", async () => {
        const plan = { windows: [pool("five_hour"), pool("seven_day"), pool("model:Opus", { models: ["Opus"] })], measuredAt: 1 };
        const opus = spentOn("claude-opus-4-6", "acct");
        const { deps, ledger } = await onFile({ acct: plan }, "claude", [spentOn("claude-sonnet-4-6", "acct"), opus]);
        providerAnswered(deps, "claude", "acct", "claude-haiku-4-5", ASKED);
        await waitFor(async () => expect(await ledger.onFile()).toEqual({ claude: [opus] }), SETTLES);
    });

    test("settles nothing more where a routed provider's readings disagree, or nothing is read", async () => {
        const entitled = { windows: [pool("monthly"), pool("entitlement:gpt-6.1-sol", { models: ["gpt-6.1-sol"] })], measuredAt: 1 };
        const sol = spentOn("gpt-6.1-sol");
        const split = await onFile({ "codex:codex-team.json": { windows: [pool("five_hour")], measuredAt: 1 }, "codex:codex-free.json": entitled }, "codex", [sol]);
        providerAnswered(split.deps, "codex", "codex-subscription", "gpt-6-luna", ASKED);
        const unread = await onFile({}, "codex", [sol]);
        providerAnswered(unread.deps, "codex", "codex-subscription", "gpt-6-luna", ASKED);
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const { ledger } of [split, unread]) {
            expect(await ledger.onFile()).toEqual({ codex: [sol] });
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
        { kind: "model-refusal", provider: "cursor", model: "m", refusal: { at: 1, message: "not covered" } },
        { kind: "seat-refusal", account: "acct", reason: "switched off" },
    ];

    test("each reach their own store", async () => {
        const { deps, writes } = recorded();
        performFailureWrites(deps, all);
        await waitFor(() => expect(writes.seatsRefused).toHaveLength(1), SETTLES);
        expect(writes.providerRefusals).toStrictEqual([
            { provider: "cursor", refusal: { at: 1, kind: "limit", message: "spent", account: "acct", model: "m" } },
        ]);
        expect(writes.headroomRefreshes).toStrictEqual([{ scope: { providers: ["cursor"], account: "acct" }, maxAgeMs: 0 }]);
        expect(writes.modelRefusals).toStrictEqual([{ provider: "cursor", model: "m", refusal: { at: 1, message: "not covered" } }]);
        expect(writes.seatsRefused).toStrictEqual([{ account: "acct", reason: "switched off" }]);
    });

    test("that fail are each logged under their own name", async () => {
        const base = services();
        const { deps, writes, lines } = recorded({
            providerRefusals: { ...base.providerRefusals, record: rejecting },
            modelRefusals: { refused: async () => new Set(), record: rejecting },
            claudeSeats: { ...base.claudeSeats, refuse: rejecting },
        });
        performFailureWrites(deps, all);
        await waitFor(() => expect(warnings(lines)).toHaveLength(3), SETTLES);
        expect(warnings(lines)).toStrictEqual(["provider refusal: write failed", "model refusal: write failed", "claude account: could not record the entitlement refusal"]);
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

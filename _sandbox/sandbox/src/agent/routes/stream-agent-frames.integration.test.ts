import type { AgentEvent, UsageWindow } from "@intentic/sandbox-contract";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { Services } from "../../composition.js";
import { collect } from "../../harness/route-client.testing.js";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import { codexConnectedProxy, recordingTurnStores, services, withTranslator } from "../../harness/route-services.testing.js";
import type { ConversationEvent } from "../../agents/actor/conversation-decide.js";
import { notedFleet } from "../../testing.js";
import { recordProviderSuccess } from "../providers/provider-health.js";
import type { SentTurn } from "../../seams/turn-starter.js";
import * as verifyNudge from "../verification/verify-nudge.js";
import type { AgentRequest } from "../providers/agent-request.js";
import { streamAgent } from "./agent.routes.js";

// streamAgent's wiring with a scripted runtime: frames, settled stores, the recorded hold; the matrix is classify-failure.test.ts.

// The resume bookkeeping is what the turn tells its conversation, noted as it is sent (`turnServices`); the verify nudge
// is module state, recorded on its way through to the real one.
const resumes = [] as { readonly conversationId: string; readonly event: ConversationEvent }[];
const nudges = [] as Parameters<typeof verifyNudge.nudgeUnverifiedWork>[0][];
// The events that are resume bookkeeping, among everything else a turn tells its conversation.
const RESUME_EVENTS: ReadonlySet<string> = new Set(["resume-superseded", "turn-got-somewhere", "turn-held"]);
jest.mock("../verification/verify-nudge.js", () => ({
    ...verifyNudge,
    nudgeUnverifiedWork: async (nudge: Parameters<typeof verifyNudge.nudgeUnverifiedWork>[0]) => {
        nudges.push(nudge);
        return undefined;
    },
}));

afterEach(() => {
    resumes.length = 0;
    nudges.length = 0;
    // The outage breaker is one clock per provider for the whole process.
    recordProviderSuccess("claude");
    recordProviderSuccess("codex");
});

// A turn's services with every write recorded; the repo sync answers current so no advisory depends on the machine.
const turnServices = (
    agent: (request: AgentRequest) => AsyncGenerator<AgentEvent>,
    extra: Parameters<typeof services>[0] = {},
    snapshot?: string,
): { readonly services: Services; readonly writes: ReturnType<typeof recordingTurnStores>["writes"]; readonly lines: Record<string, unknown>[] } => {
    const recorded = recordingTurnStores(snapshot === undefined ? {} : { snapshot });
    const { lines, logger } = recordingLogger();
    return {
        services: services({
            ...recorded.overrides,
            logger,
            git: { sync: async () => ({ status: "current" }) },
            agent,
            ...notedFleet((conversationId, event) => {
                if (RESUME_EVENTS.has(event.kind)) {
                    resumes.push({ conversationId, event });
                }
            }),
            ...extra,
        }),
        writes: recorded.writes,
        lines,
    };
};

const scripted = (frames: readonly AgentEvent[]) =>
    async function* (): AsyncGenerator<AgentEvent> {
        yield* frames;
    };

// Only the lines the failure branch writes, which are the ones a refusal or a failure is triaged from.
const failureLines = (lines: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
    lines.filter((line) => line["message"] === "turn failed" || line["message"] === "turn refused");

const edit: AgentEvent = {
    kind: "tool_call",
    id: "call-edit",
    name: "Edit",
    category: "edit",
    status: "completed",
    locations: [{ path: "/work/src/parser.ts" }],
};
const check: AgentEvent = {
    kind: "tool_call",
    id: "call-test",
    name: "Bash",
    category: "execute",
    status: "in_progress",
    target: "pnpm test src/parser.test.ts",
};
const checked: AgentEvent = {
    kind: "tool_call_update",
    id: "call-test",
    status: "completed",
    content: [{ type: "text", text: "2 passed\n--- [exit 0, 3s]" }],
};
const windows: UsageWindow[] = [{ kind: "five_hour", utilization: 42, resetsAt: 1_900_000_000, gates: "all" }];

test("a clean turn streams every frame once, stamps the ones that name an account, and settles into every store", async () => {
    const input: SentTurn = { prompt: "ship the parser", conversationId: "frames-clean", actor: "ada@example.com", byPerson: true };
    const {
        services: s,
        writes,
        lines,
    } = turnServices(
        scripted([
            { kind: "session", sessionId: "s-clean" },
            { kind: "delta", text: "Looking." },
            edit,
            check,
            checked,
            {
                kind: "todos",
                items: [
                    { content: "fix", status: "completed" },
                    { content: "test", status: "in_progress" },
                ],
            },
            { kind: "plan", requestId: "plan-1", text: "1. fix it" },
            { kind: "usage", costUsd: 0.25, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, numTurns: 1, durationMs: 1_000 },
            { kind: "rate_limit_info", status: "allowed", resetsAt: 1_900_000_000 },
            { kind: "account_usage", windows: [...windows] },
            { kind: "compact", trigger: "auto", preTokens: 180_000, postTokens: 40_000 },
            { kind: "context_usage", tokens: 1_200, contextWindow: 200_000, cachedAt: 1_700_000_000_000 },
            { kind: "usage", costUsd: 0.5, inputTokens: 50, outputTokens: 10, numTurns: 1, durationMs: 500 },
            { kind: "delta", text: "Done." },
            { kind: "done" },
        ]),
    );

    const frames = await collect(streamAgent(s, input, undefined));

    const stamp = { account: "default", actor: "ada@example.com" };
    expect(frames).toStrictEqual([
        { kind: "session", sessionId: "s-clean", ...stamp },
        { kind: "delta", text: "Looking." },
        edit,
        check,
        checked,
        {
            kind: "todos",
            items: [
                { content: "fix", status: "completed" },
                { content: "test", status: "in_progress" },
            ],
        },
        { kind: "plan", requestId: "plan-1", text: "1. fix it" },
        { kind: "usage", costUsd: 0.25, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, numTurns: 1, durationMs: 1_000, ...stamp },
        { kind: "rate_limit_info", status: "allowed", resetsAt: 1_900_000_000, ...stamp },
        { kind: "account_usage", windows: [...windows], ...stamp },
        { kind: "compact", trigger: "auto", preTokens: 180_000, postTokens: 40_000 },
        // A Claude subscription's own cache rule finishes the frame the stream could only half-fill.
        { kind: "context_usage", tokens: 1_200, contextWindow: 200_000, cachedAt: 1_700_000_000_000, cacheTtlMs: 3_600_000 },
        { kind: "usage", costUsd: 0.5, inputTokens: 50, outputTokens: 10, numTurns: 1, durationMs: 500, ...stamp },
        { kind: "delta", text: "Done." },
        { kind: "done" },
    ]);
    await waitFor(() => expect(writes.headroomRecords).toHaveLength(1), SETTLES);

    const row = {
        provider: "claude",
        direction: "system" as const,
        turnId: expect.any(String),
        ...stamp,
        conversationId: "frames-clean",
        title: "Ship the parser",
    };
    expect(writes.activity).toStrictEqual([
        { ...row, type: "turn.started", content: "ship the parser" },
        { ...row, sessionId: "s-clean", type: "turn.plan", content: "1. fix it", extra: { requestId: "plan-1" } },
        {
            ...row,
            sessionId: "s-clean",
            type: "turn.completed",
            // Summed, not the last frame's: a steer is a second SDK turn inside the same one.
            extra: { costUsd: 0.75, inputTokens: 150, outputTokens: 30, cacheReadTokens: 5, durationMs: 1_500, numTurns: 2 },
        },
    ]);
    expect(new Set(writes.activity.map((event) => event.turnId)).size).toBe(1);
    expect(writes.usage).toStrictEqual([
        {
            provider: "claude",
            ...stamp,
            harness: "native",
            outcome: "ok",
            conversationId: "frames-clean",
            turns: 2,
            inputTokens: 150,
            outputTokens: 30,
            cacheReadTokens: 5,
            cacheCreationTokens: 0,
            costUsd: 0.75,
            durationMs: 1_500,
            verification: "verified",
            check: "pnpm test src/parser.test.ts",
            filesEdited: 1,
            toolCalls: 2,
            compactions: 1,
            checklistTotal: 2,
            checklistOpen: 1,
            contextTokens: 1_200,
            contextWindow: 200_000,
            searchCalls: 0,
            openingSearches: 0,
            openingListings: 0,
            failedCalls: 0,
            callsBeforeTarget: 0,
            turnIndex: 0,
            autoPicked: undefined,
        },
    ]);
    // The first answer settles what this account last refused, the provider's mark and the seat's.
    expect(writes.refusalsCleared).toStrictEqual([{ provider: "claude", account: "default" }]);
    expect(writes.seatsCleared).toStrictEqual(["default"]);
    expect(writes.headroomRecords).toStrictEqual([
        { provider: "claude", account: "default", usage: { windows: [...windows], measuredAt: expect.any(Number) } },
    ]);
    expect(writes.headroomRefreshes).toStrictEqual([]);
    expect(writes.providerRefusals).toStrictEqual([]);
    expect(writes.snapshots).toStrictEqual([{ trigger: "user" }, { trigger: "turn", label: "ship the parser" }]);
    expect(writes.checkpoints).toStrictEqual([]);
    expect(resumes).toStrictEqual([
        { conversationId: "frames-clean", event: { kind: "resume-superseded" } },
        { conversationId: "frames-clean", event: { kind: "turn-got-somewhere" } },
    ]);
    expect(failureLines(lines)).toStrictEqual([]);
    // Claude runs its own Stop: the daemon neither runs the turn-ending rules nor nudges.
    expect(nudges).toStrictEqual([]);
});

test("a spent allowance naming its reset is held whole, filed as a limit, and re-measured", async () => {
    const input: SentTurn = { prompt: "carry on", conversationId: "frames-limit", actor: "ada@example.com", model: "opus", byPerson: true };
    const {
        services: s,
        writes,
        lines,
    } = turnServices(
        scripted([
            { kind: "session", sessionId: "s-limit" },
            { kind: "rate_limit_info", status: "rejected", resetsAt: 1_900_000_000 },
            { kind: "error", code: "rate_limit", message: "Claude usage limit reached." },
            { kind: "done" },
        ]),
    );

    const frames = await collect(streamAgent(s, input, undefined));

    const stamp = { account: "default", actor: "ada@example.com" };
    expect(frames).toStrictEqual([
        { kind: "session", sessionId: "s-limit", ...stamp },
        { kind: "rate_limit_info", status: "rejected", resetsAt: 1_900_000_000, ...stamp },
        {
            kind: "error",
            code: "rate_limit",
            message: "Claude usage limit reached.",
            held: { ran: false, handoffTokens: expect.any(Number) },
            resetsAt: 1_900_000_000,
            autoResume: "available",
        },
        { kind: "done" },
    ]);
    expect(writes.providerRefusals).toStrictEqual([
        {
            provider: "claude",
            refusal: { at: expect.any(Number), kind: "limit", message: "Claude usage limit reached.", ...stamp, model: "opus" },
        },
    ]);
    expect(writes.headroomRefreshes).toStrictEqual([{ scope: { providers: ["claude"], account: "default" }, maxAgeMs: 0 }]);
    // Claude publishes its plan limits, so the refusal is not the reading; nor is a native provider's model benched.
    expect(writes.observedLimits).toStrictEqual([]);
    expect(writes.modelCooldowns).toStrictEqual([]);
    expect(writes.modelRefusals).toStrictEqual([]);
    expect(resumes).toStrictEqual([
        { conversationId: "frames-limit", event: { kind: "resume-superseded" } },
        {
            conversationId: "frames-limit",
            event: {
                kind: "turn-held",
                held: {
                    input: { ...input, conversationId: "frames-limit" },
                    reason: "limit",
                    sessionId: "s-limit",
                    ran: false,
                    reopensAt: 1_900_000_000,
                    standing: { state: "no-code", paths: [], check: undefined },
                    handoffTokens: expect.any(Number),
                },
            },
        },
    ]);
    expect(failureLines(lines)).toStrictEqual([
        {
            level: "warn",
            turnId: expect.any(String),
            provider: "claude",
            harness: "native",
            code: "rate_limit",
            model: "opus",
            ...stamp,
            conversationId: "frames-limit",
            sessionId: "s-limit",
            reason: "Claude usage limit reached.",
            message: "turn refused",
        },
    ]);
    const row = {
        provider: "claude",
        direction: "system" as const,
        turnId: expect.any(String),
        ...stamp,
        conversationId: "frames-limit",
        title: "Carry on",
    };
    expect(writes.activity).toStrictEqual([
        { ...row, type: "turn.started", content: "carry on" },
        { ...row, sessionId: "s-limit", type: "turn.error", outcome: "error", error: "Claude usage limit reached." },
        { ...row, sessionId: "s-limit", type: "turn.completed" },
    ]);
    // Refused before it answered: billed nothing, and no verdict on work it never did.
    expect(writes.usage).toStrictEqual([
        {
            provider: "claude",
            ...stamp,
            model: "opus",
            modelRequested: "opus",
            harness: "native",
            outcome: "error",
            errorCode: "rate_limit",
            errorMessage: "Claude usage limit reached.",
            conversationId: "frames-limit",
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
            durationMs: 0,
            turnIndex: 0,
            autoPicked: undefined,
        },
    ]);
});

test("an outage goes out as the breaker's retry frame, and remembers the session for the resume", async () => {
    const input: SentTurn = { prompt: "keep going", conversationId: "frames-outage", byPerson: true };
    const {
        services: s,
        writes,
        lines,
    } = turnServices(
        scripted([
            { kind: "session", sessionId: "s-outage" },
            { kind: "error", code: "provider-outage", message: "Anthropic is overloaded." },
            { kind: "done" },
        ]),
    );

    const frames = await collect(streamAgent(s, input, undefined));

    expect(frames).toStrictEqual([
        { kind: "session", sessionId: "s-outage", account: "default" },
        {
            kind: "error",
            code: "provider-outage",
            message: "Anthropic is overloaded.",
            autoResume: "available",
            outage: { retryAt: expect.any(Number) },
            retries: { made: 0, max: 6 },
        },
        { kind: "done" },
    ]);
    expect(resumes).toStrictEqual([
        { conversationId: "frames-outage", event: { kind: "resume-superseded" } },
        {
            conversationId: "frames-outage",
            event: {
                kind: "turn-held",
                held: { input: { ...input, conversationId: "frames-outage" }, reason: "outage", sessionId: "s-outage", ran: false },
            },
        },
    ]);
    expect(writes.providerRefusals).toStrictEqual([]);
    expect(writes.headroomRefreshes).toStrictEqual([]);
    expect(failureLines(lines)).toStrictEqual([
        {
            level: "warn",
            turnId: expect.any(String),
            provider: "claude",
            harness: "native",
            code: "provider-outage",
            account: "default",
            conversationId: "frames-outage",
            sessionId: "s-outage",
            reason: "Anthropic is overloaded.",
            message: "turn refused",
        },
    ]);
});

test("a refused credential is promised a re-mint and held for it, unless the turn is itself the re-mint", async () => {
    const input: SentTurn = { prompt: "go", conversationId: "frames-token", byPerson: true };
    const refusal = scripted([
        { kind: "session", sessionId: "s-token" },
        { kind: "error", code: "claude-token-refused", message: "401 invalid bearer token" },
        { kind: "done" },
    ]);
    const { services: s, writes } = turnServices(refusal);

    const frames = await collect(streamAgent(s, input, undefined));

    expect(frames).toStrictEqual([
        { kind: "session", sessionId: "s-token", account: "default" },
        { kind: "error", code: "claude-token-refused", message: "401 invalid bearer token", autoResume: "scheduled" },
        { kind: "done" },
    ]);
    expect(writes.providerRefusals).toStrictEqual([
        { provider: "claude", refusal: { at: expect.any(Number), kind: "auth", message: "401 invalid bearer token", account: "default" } },
    ]);
    expect(writes.headroomRefreshes).toStrictEqual([{ scope: { providers: ["claude"], account: "default" }, maxAgeMs: 0 }]);
    expect(resumes).toStrictEqual([
        { conversationId: "frames-token", event: { kind: "resume-superseded" } },
        {
            conversationId: "frames-token",
            event: {
                kind: "turn-held",
                held: {
                    input: { ...input, conversationId: "frames-token" },
                    reason: "auth",
                    sessionId: "s-token",
                    ran: false,
                    remint: { account: "default", refusedToken: "tok-xyz" },
                },
            },
        },
    ]);

    resumes.length = 0;
    const again = turnServices(refusal);
    const rerun = await collect(streamAgent(again.services, { ...input, conversationId: "frames-token-again", resume: "auth", byPerson: false }, undefined));
    expect(rerun.find((frame) => frame.kind === "error")).toStrictEqual({
        kind: "error",
        code: "claude-token-refused",
        message: "401 invalid bearer token",
    });
    expect(resumes).toStrictEqual([
        { conversationId: "frames-token-again", event: { kind: "resume-superseded" } },
        { conversationId: "frames-token-again", event: { kind: "turn-got-somewhere" } },
    ]);
});

test("a turn that ends with nothing to show gets its failure synthesized ahead of done, and is held like any stopped turn", async () => {
    const { services: s, writes } = turnServices(
        scripted([
            { kind: "tool_call", id: "call-read", name: "Read", category: "read", status: "completed", locations: [{ path: "/work/src/parser.ts" }] },
            { kind: "done" },
        ]),
    );

    const frames = await collect(streamAgent(s, { prompt: "fix the parser", conversationId: "frames-silent", byPerson: true }, undefined));

    const sentence =
        "The turn ended with nothing to show for it: 1 tool call and then a stop, no reply and no change to a file. Nothing failed: the session is intact, so carrying on continues from where it stopped.";
    expect(frames).toStrictEqual([
        { kind: "tool_call", id: "call-read", name: "Read", category: "read", status: "completed", locations: [{ path: "/work/src/parser.ts" }] },
        { kind: "error", message: sentence, held: { ran: true }, autoResume: "available" },
        { kind: "done" },
    ]);
    expect(writes.activity.map(({ type, error }) => ({ type, error }))).toStrictEqual([
        { type: "turn.started", error: undefined },
        { type: "turn.error", error: sentence },
        { type: "turn.completed", error: undefined },
    ]);
    expect(resumes.map(({ event }) => event.kind)).toStrictEqual(["resume-superseded", "turn-held"]);
});

test("a stopped turn's error frames never reach the stream, and the ledger calls it cancelled", async () => {
    const controller = new AbortController();
    const {
        services: s,
        writes,
        lines,
    } = turnServices(async function* () {
        yield { kind: "session", sessionId: "s-cancel" };
        yield { kind: "delta", text: "working" };
        controller.abort();
        yield { kind: "error", message: "aborted by the user" };
        yield { kind: "done" };
    });

    const frames = await collect(streamAgent(s, { prompt: "go", conversationId: "frames-cancel", byPerson: true }, controller.signal));

    expect(frames).toStrictEqual([
        { kind: "session", sessionId: "s-cancel", account: "default" },
        { kind: "delta", text: "working" },
        { kind: "done" },
    ]);
    expect(writes.activity.map(({ type }) => type)).toStrictEqual(["turn.started", "turn.completed"]);
    expect(writes.usage.map(({ outcome }) => outcome)).toStrictEqual(["cancelled"]);
    expect(failureLines(lines)).toStrictEqual([]);
    expect(resumes).toStrictEqual([
        { conversationId: "frames-cancel", event: { kind: "resume-superseded" } },
        { conversationId: "frames-cancel", event: { kind: "turn-got-somewhere" } },
    ]);
});

test("a runtime with no Stop hook gets the daemon's: routed readings re-measured, the cache clock dropped, the nudge asked", async () => {
    const input: SentTurn = { prompt: "carry on", conversationId: "frames-codex", agent: "codex", byPerson: true };
    const codex = scripted([
        { kind: "session", sessionId: "thread-1" },
        { kind: "delta", text: "on it" },
        edit,
        { kind: "account_usage", windows: [...windows] },
        { kind: "context_usage", tokens: 3_000, contextWindow: 400_000, cachedAt: 1_700_000_000_000 },
        { kind: "usage", costUsd: 0.1, inputTokens: 10 },
        { kind: "done" },
    ]);
    const { services: s, writes } = turnServices(codex, { config: withTranslator, cliProxy: codexConnectedProxy, codexAgent: codex });

    const frames = await collect(streamAgent(s, input, undefined));

    const stamp = { account: "codex-subscription" };
    expect(frames).toStrictEqual([
        // Planning's own note, disclosed before the runtime says anything.
        { kind: "preamble", notes: [{ title: "Spawning child agents", text: expect.any(String) }] },
        { kind: "session", sessionId: "thread-1", ...stamp },
        { kind: "delta", text: "on it" },
        edit,
        { kind: "account_usage", windows: [...windows], ...stamp },
        // Nobody publishes this provider's cache lifetime, so the instant goes with the TTL it never had.
        { kind: "context_usage", tokens: 3_000, contextWindow: 400_000 },
        { kind: "usage", costUsd: 0.1, inputTokens: 10, ...stamp },
        { kind: "done" },
    ]);
    await waitFor(() => expect(writes.headroomRefreshes).toHaveLength(2), SETTLES);
    expect(writes.headroomRefreshes).toStrictEqual([
        // The reading the stream carried, with no shared key to file it under, becomes a re-read instead.
        { scope: { providers: ["codex"] }, maxAgeMs: 0 },
        // And the settled turn's files are re-read, since a routed turn never learns which one served it.
        { scope: { providers: ["codex"] }, maxAgeMs: 10_000 },
    ]);
    expect(nudges.map(({ conversationId, profile, rules, cwd, findings }) => ({ conversationId, profile, rules, cwd, findings }))).toStrictEqual([
        { conversationId: "frames-codex", profile: { agent: "codex" }, rules: [], cwd: "/work", findings: [] },
    ]);
    expect(nudges[0]?.ledger.standing()).toStrictEqual({ state: "unproven", paths: ["/work/src/parser.ts"], check: undefined });
});

import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentEvent, type AccountUsage, type PromptFingerprint, SandboxSettingsSchema, type UsageTurn } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { services } from "../../../harness/route-services.testing.js";
import { beginTurn } from "../../../testing.js";
import { KEEP_WARM_PROMPT } from "../../../runtimes/claude/claude-warm.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import type { AgentRequest, TurnHooks } from "../../providers/agent-request.js";
import type { HarnessRequest } from "../agent.js";
import { nextPromptDayAt } from "../prompt-fingerprint.js";
import { armKeepWarm, autoKeepWarm, dropKeepWarm, keepableOf, keepWarmDueOf, noteKeepable, stopKeepWarm, tendKeepWarm } from "./cache-keepwarm.js";

// Only the runtime is fake: the actor, registry, reducer and provider module a refresh reports into are the real ones.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Ten in the morning where the CLI runs: far enough from midnight that only the midnight case meets it.
const T0 = nextPromptDayAt(Date.UTC(2026, 8, 23, 12)) + 10 * 60 * 60_000;
const ID = "c1";

const PRINT: PromptFingerprint = { hash: "h1", parts: { version: "1.0.0", model: "claude-opus-5-5", system: "s1", day: "2026-09-24", tools: "t1" } };

const INPUT: RoutedTurn = { prompt: "the last turn's words", agent: "claude", harness: "native" };

const CARDS: TurnHooks["cards"] = unstubbed<TurnHooks["cards"]>("cards", {});

// The request the last turn sent, with everything a refresh must not send again: its notes, attachments, conversation,
// and a hook that rebases the tree.
const lastRequest = (credential: AgentRequest["credential"] = { kind: "claude-oauth", token: "stale-token" }): AgentRequest => ({
    spec: {
        prompt: "the last turn's words",
        notes: [{ title: "Open in the editor", text: "a.ts" }],
        attachments: ["/work/shot.png"],
        cwd: WORKSPACE_ROOT,
        conversationId: ID,
        model: "claude-opus-5-5",
        effort: "high",
        systemAppend: "the delegation note",
    },
    policy: { permissionMode: "bypassPermissions" },
    tools: { iqAvailable: true },
    hooks: { cards: CARDS, resync: async () => undefined },
    credential,
    signal: new AbortController().signal,
});

// Files what the last turn left to keep, as the settle does.
const keep = (deps: Services, over: { readonly sessionId?: string; readonly request?: AgentRequest } = {}): void =>
    noteKeepable(
        deps,
        ID,
        keepableOf(deps, { input: INPUT, request: over.request ?? lastRequest(), account: "acct", sessionId: over.sessionId ?? "s-1", fingerprint: PRINT, spawned: false }),
    );

interface Harness {
    readonly deps: Services;
    readonly sent: HarnessRequest[];
    readonly rows: Omit<UsageTurn, "at" | "day">[];
}

// The frames a refresh hears, stopping where its own signal says it was cut off.
const harness = (frames: readonly AgentEvent[], opts: { usage?: AccountUsage; keepWarm?: boolean; seatRefusal?: string } = {}): Harness => {
    const sent: HarnessRequest[] = [];
    const rows: Omit<UsageTurn, "at" | "day">[] = [];
    const deps = services({
        async *agent (request) {
            sent.push(request);
            for (const frame of frames) {
                if (request.signal.aborted) {
                    return;
                }
                yield frame;
            }
        },
        claudeStore: {
            read: async (id: string) => ({ id, label: id, connectedAt: 0, accessToken: `fresh-${id}` }),
            list: async () => [{ id: "acct", label: "acct", connectedAt: 0 }],
        },
        claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", {
            read: async () => (opts.seatRefusal === undefined ? {} : { acct: { at: 0, reason: opts.seatRefusal } }),
        }),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { read: async () => ({}) }),
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => (opts.usage === undefined ? {} : { acct: opts.usage }) }),
        sandboxSettings: { get: async () => SandboxSettingsSchema.parse({ keepWarm: { auto: opts.keepWarm ?? false } }) },
        usage: {
            record: async (row) => {
                rows.push(row);
            },
        },
    });
    return { deps, sent, rows };
};

// Opens, binds and settles one turn whose last request touched the cache at `cachedAt`.
const settled = async (deps: Services, cachedAt: number = T0): Promise<void> => {
    await beginTurn(deps.conversations, { conversationId: ID, prompt: "go", isolated: false, profile: { agent: "claude", harness: "native", account: "acct" } }, cachedAt - MINUTE);
    deps.conversations.send(ID, { kind: "frame", frame: { kind: "session", sessionId: "s-1", account: "acct" } }, cachedAt);
    deps.conversations.send(ID, { kind: "frame", frame: { kind: "context_usage", tokens: 200_000, contextWindow: 1_000_000, cachedAt, cacheTtlMs: HOUR } }, cachedAt);
    await deps.conversations.send(ID, { kind: "settle" }, cachedAt).settled;
};

const refreshed = (at: number, read = 198_000, written = 2_000): AgentEvent[] => [
    { kind: "init", model: "claude-opus-5-5", prompt: PRINT },
    { kind: "prompt_cache", readTokens: read, writtenTokens: written },
    { kind: "usage", inputTokens: 5, outputTokens: 3, cacheReadTokens: read, cacheCreationTokens: written, costUsd: 0.05, numTurns: 1 },
    { kind: "context_usage", tokens: read + written, contextWindow: 1_000_000, cachedAt: at },
    { kind: "done" },
];

const hold = (deps: Services) => deps.conversations.state(ID)?.keepWarm;

describe("arming", () => {
    test("is refused where no turn left a request to replay", async () => {
        const { deps } = harness([]);
        await settled(deps);
        keep(deps, { request: lastRequest({ kind: "container" }) });
        expect(deps.conversations.state(ID)?.turn.keepable).toBeUndefined();
        expect(armKeepWarm(deps, ID, T0 + 4 * HOUR, T0 + MINUTE)).toEqual({ refused: expect.stringContaining("Nothing to keep warm") });
    });

    test("is refused once the cache has already expired", async () => {
        const { deps } = harness([]);
        await settled(deps);
        keep(deps);
        expect(armKeepWarm(deps, ID, T0 + 4 * HOUR, T0 + HOUR + MINUTE)).toEqual({ refused: expect.stringContaining("already cold") });
    });

    test("cuts `until` to what refreshing can honestly keep", async () => {
        const { deps } = harness([]);
        await settled(deps);
        keep(deps);
        expect(armKeepWarm(deps, ID, T0 + 12 * HOUR, T0 + MINUTE)).toEqual({ ok: true });
        // An hour's entry, nine refreshes fifty minutes apart, and midnight still fourteen hours away.
        expect(hold(deps)?.until).toBe(T0 + HOUR + 9 * 50 * MINUTE);
    });

    test("counts the refreshes a live hold already spent, so re-arming cannot outrun them", async () => {
        const { deps } = harness([]);
        await settled(deps);
        keep(deps);
        armKeepWarm(deps, ID, T0 + 2 * HOUR, T0 + MINUTE);
        const last = T0 + 150 * MINUTE;
        for (const at of [T0 + 50 * MINUTE, T0 + 100 * MINUTE, last]) {
            deps.conversations.send(ID, { kind: "keep-warm-refreshed", at, ttlMs: HOUR, readTokens: 1 });
        }
        armKeepWarm(deps, ID, T0 + 20 * HOUR, last + MINUTE);
        expect(hold(deps)?.until).toBe(last + HOUR + 6 * 50 * MINUTE);
    });

    test("tells every card how far the conversation can be kept, by its provider's prices", async () => {
        const { deps } = harness([]);
        await settled(deps);
        keep(deps);
        // An hour's Claude entry: nine refreshes fifty minutes apart before a re-read costs more than a cold resume.
        expect(deps.conversations.state(ID)?.turn.keepable).toEqual({ budget: 9 });
        expect(deps.agents.get(ID)?.promptCache).toEqual({ at: T0, ttlMs: HOUR, rollsAt: nextPromptDayAt(T0), keepableUntil: T0 + HOUR + 9 * 50 * MINUTE });
    });

    test("tells every card a live hold's spent refreshes shorten the reach", async () => {
        const { deps } = harness([]);
        await settled(deps);
        keep(deps);
        armKeepWarm(deps, ID, T0 + 2 * HOUR, T0 + MINUTE);
        deps.conversations.send(ID, { kind: "keep-warm-refreshed", at: T0 + 50 * MINUTE, ttlMs: HOUR, readTokens: 1 });
        expect(deps.agents.get(ID)?.promptCache?.keepableUntil).toBe(T0 + 50 * MINUTE + HOUR + 8 * 50 * MINUTE);
    });

    test("leaves a spawned child's turn, or a runtime that cannot keep a cache, with nothing to keep", async () => {
        const { deps } = harness([]);
        const turn = { input: INPUT, request: lastRequest(), account: "acct", sessionId: "s-1", fingerprint: PRINT, spawned: false };
        expect(keepableOf(deps, turn)).toMatchObject({ provider: "claude", harness: "native", account: "acct", sessionId: "s-1", fingerprint: PRINT });
        expect(keepableOf(deps, { ...turn, spawned: true })).toBeUndefined();
        expect(keepableOf(deps, { ...turn, input: { ...INPUT, agent: "codex" } })).toBeUndefined();
    });

    test("sets the hold's one deadline at the exact instant its first refresh is due", async () => {
        const { deps } = harness([]);
        await settled(deps);
        keep(deps);
        armKeepWarm(deps, ID, T0 + 4 * HOUR, T0 + MINUTE);
        expect(keepWarmDueOf(deps, ID)).toBe(T0 + 50 * MINUTE);
        // A hold the cache already outlives is next looked at when it runs out.
        armKeepWarm(deps, ID, T0 + 30 * MINUTE, T0 + 2 * MINUTE);
        expect(keepWarmDueOf(deps, ID)).toBe(T0 + 30 * MINUTE);
        stopKeepWarm(deps);
    });
});

describe("tending a hold", () => {
    const armed = async (frames: readonly AgentEvent[], opts: Parameters<typeof harness>[1] = {}): Promise<Harness> => {
        const built = harness(frames, opts);
        await settled(built.deps);
        keep(built.deps);
        armKeepWarm(built.deps, ID, T0 + 4 * HOUR, T0 + MINUTE);
        return built;
    };

    test("waits while the cache has time to spare, and looks again when the refresh is due", async () => {
        const { deps, sent } = await armed(refreshed(T0 + 30 * MINUTE));
        await tendKeepWarm(deps, ID, T0 + 30 * MINUTE);
        expect(sent).toHaveLength(0);
        expect(hold(deps)?.refreshes).toBe(0);
        expect(keepWarmDueOf(deps, ID)).toBe(T0 + 50 * MINUTE);
        stopKeepWarm(deps);
    });

    test("sends the provider's refresh once it is due, built from the last turn's prefix alone, and restarts the clock", async () => {
        const { deps, sent, rows } = await armed(refreshed(T0 + 51 * MINUTE));
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        const [request] = sent;
        expect(request?.policy).toEqual({ permissionMode: "bypassPermissions", keepWarm: true });
        expect(request?.tools).toEqual({ iqAvailable: true });
        expect(request?.spec).toEqual({
            prompt: KEEP_WARM_PROMPT,
            cwd: WORKSPACE_ROOT,
            model: "claude-opus-5-5",
            effort: "high",
            systemAppend: "the delegation note",
            sessionId: "s-1",
            steering: expect.anything(),
        });
        // Only the card seam the permission gate needs: nothing the turn did (a rebase, its notes) runs again.
        expect(request?.hooks).toEqual({ cards: CARDS });
        expect(request?.credential).toEqual({ kind: "claude-oauth", token: "fresh-acct" });
        expect(hold(deps)).toEqual({ since: T0 + MINUTE, until: T0 + 4 * HOUR, refreshes: 1, readTokens: 198_000 });
        expect(deps.conversations.state(ID)?.turn.promptCache).toEqual({ at: T0 + 51 * MINUTE, ttlMs: HOUR });
        expect(rows).toEqual([expect.objectContaining({ purpose: "keep-warm", conversationId: ID, account: "acct", cacheReadTokens: 198_000 })]);
        expect(keepWarmDueOf(deps, ID)).toBe(T0 + 101 * MINUTE);
        stopKeepWarm(deps);
    });

    test("stops before its request lands when a keyed part of the prompt moved", async () => {
        const moved: PromptFingerprint = { hash: "h2", parts: { ...PRINT.parts, version: "1.1.0" } };
        const { deps } = await armed([{ kind: "init", model: "claude-opus-5-5", prompt: moved }, ...refreshed(T0 + 51 * MINUTE).slice(1)]);
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(hold(deps)?.ended).toEqual({ at: T0 + 51 * MINUTE, reason: "changed", detail: "version" });
        expect(hold(deps)?.refreshes).toBe(0);
    });

    test("leaves a change in the tool list to the cache's own numbers", async () => {
        const tools: PromptFingerprint = { hash: "h3", parts: { ...PRINT.parts, tools: "t2" } };
        const { deps } = await armed([{ kind: "init", model: "claude-opus-5-5", prompt: tools }, ...refreshed(T0 + 51 * MINUTE).slice(1)]);
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(hold(deps)?.refreshes).toBe(1);
    });

    test("ends when a refresh had to write the context again", async () => {
        const { deps } = await armed(refreshed(T0 + 51 * MINUTE, 0, 200_000));
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(hold(deps)?.ended).toEqual({ at: T0 + 51 * MINUTE, reason: "cold", detail: "a refresh wrote 200000 tokens again" });
        expect(keepWarmDueOf(deps, ID)).toBeUndefined();
    });

    test("ends when the provider refuses the refresh for the account's limit", async () => {
        const { deps } = await armed([{ kind: "error", code: "rate_limit", message: "You've hit your session limit" }, { kind: "done" }]);
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(hold(deps)?.ended).toEqual({ at: T0 + 51 * MINUTE, reason: "allowance", detail: "You've hit your session limit" });
    });

    test("ends without sending anything once the account is past its reserve", async () => {
        const usage: AccountUsage = { measuredAt: T0, windows: [{ kind: "five_hour", utilization: 90, gates: "all" }] };
        const { deps, sent } = await armed(refreshed(T0 + 51 * MINUTE), { usage });
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(sent).toHaveLength(0);
        expect(hold(deps)?.ended).toEqual({ at: T0 + 51 * MINUTE, reason: "allowance", detail: "90%" });
    });

    test("ends without sending anything once the account is spent, or can serve no turn at all", async () => {
        const usage: AccountUsage = { measuredAt: T0, windows: [{ kind: "five_hour", utilization: 100, gates: "all" }] };
        const spent = await armed(refreshed(T0 + 51 * MINUTE), { usage });
        await tendKeepWarm(spent.deps, ID, T0 + 51 * MINUTE);
        expect(spent.sent).toHaveLength(0);
        expect(hold(spent.deps)?.ended).toEqual({ at: T0 + 51 * MINUTE, reason: "allowance", detail: "100%" });
        const seatless = await armed(refreshed(T0 + 51 * MINUTE), { seatRefusal: "Your organization has disabled Claude Code." });
        await tendKeepWarm(seatless.deps, ID, T0 + 51 * MINUTE);
        expect(seatless.sent).toHaveLength(0);
        expect(hold(seatless.deps)?.ended).toEqual({ at: T0 + 51 * MINUTE, reason: "failed", detail: "Your organization has disabled Claude Code." });
    });

    test("ends when the time asked for has run out", async () => {
        const { deps } = await armed([]);
        deps.conversations.send(ID, { kind: "keep-warm-refreshed", at: T0 + 3 * HOUR + 30 * MINUTE, ttlMs: HOUR, readTokens: 1 });
        await tendKeepWarm(deps, ID, T0 + 4 * HOUR);
        expect(hold(deps)?.ended?.reason).toBe("elapsed");
    });

    test("ends at midnight, when the date in the prompt changes", async () => {
        const { deps } = await armed([]);
        const midnight = nextPromptDayAt(T0);
        deps.conversations.send(ID, { kind: "keep-warm-refreshed", at: midnight - 10 * MINUTE, ttlMs: HOUR, readTokens: 1 });
        await tendKeepWarm(deps, ID, midnight + MINUTE);
        expect(hold(deps)?.ended).toMatchObject({ reason: "changed", detail: "the date in the prompt" });
    });

    test("ends when the conversation has moved to another session", async () => {
        const { deps } = await armed([]);
        keep(deps, { sessionId: "s-2" });
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(hold(deps)?.ended).toMatchObject({ reason: "changed", detail: "the conversation moved to another session" });
    });

    test("a stop press clears the hold and its deadline", async () => {
        const { deps } = await armed([]);
        dropKeepWarm(deps, ID);
        expect(hold(deps)).toBeUndefined();
        expect(keepWarmDueOf(deps, ID)).toBeUndefined();
    });

    test("a turn about to start is left to keep the cache itself, and looked at again shortly", async () => {
        const { deps, sent } = await armed(refreshed(T0 + 51 * MINUTE));
        deps.conversations.send(ID, { kind: "queue-joined", item: { id: "m-1", voice: "person", queuedAt: T0 + 50 * MINUTE, turn: { conversationId: ID, prompt: "next", messageId: "m-1" } } });
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(sent).toHaveLength(0);
        expect(keepWarmDueOf(deps, ID)).toBe(T0 + 51 * MINUTE + 15_000);
        stopKeepWarm(deps);
    });
});

describe("the sandbox-wide setting", () => {
    test("arms after a turn a person asked for, on a conversation large enough to be worth it", async () => {
        const { deps } = harness([], { keepWarm: true });
        await settled(deps);
        keep(deps);
        await autoKeepWarm(deps, { conversationId: ID, speaker: { kind: "person", email: "me@example.com" }, failure: undefined }, T0 + MINUTE);
        expect(hold(deps)).toMatchObject({ since: T0 + MINUTE, refreshes: 0 });
        stopKeepWarm(deps);
    });

    test("leaves a turn the sandbox started alone", async () => {
        const { deps } = harness([], { keepWarm: true });
        await settled(deps);
        keep(deps);
        await autoKeepWarm(deps, { conversationId: ID, speaker: undefined, failure: undefined }, T0 + MINUTE);
        expect(hold(deps)).toBeUndefined();
    });

    // A control token is a person's grant to a program: nobody sits at a composer to come back to the warm cache.
    test("leaves a turn a program asked for alone, however a person minted its token", async () => {
        const { deps } = harness([], { keepWarm: true });
        await settled(deps);
        keep(deps);
        await autoKeepWarm(deps, { conversationId: ID, speaker: { kind: "program", token: "ci bot" }, failure: undefined }, T0 + MINUTE);
        expect(hold(deps)).toBeUndefined();
    });

    test("does nothing while the setting is off", async () => {
        const { deps } = harness([]);
        await settled(deps);
        keep(deps);
        await autoKeepWarm(deps, { conversationId: ID, speaker: { kind: "person", email: "me@example.com" }, failure: undefined }, T0 + MINUTE);
        expect(hold(deps)).toBeUndefined();
    });
});

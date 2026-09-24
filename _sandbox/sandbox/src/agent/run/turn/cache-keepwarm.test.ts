import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentEvent, type AccountUsage, type PromptFingerprint, SandboxSettingsSchema, type UsageTurn } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { services } from "../../../harness/route-services.testing.js";
import { beginTurn } from "../../../testing.js";
import type { HarnessRequest } from "../agent.js";
import { nextPromptDayAt } from "../prompt-fingerprint.js";
import { armKeepWarm, autoKeepWarm, dropKeepWarm, KEEP_WARM_PROMPT, noteReplay, tendKeepWarm, type WarmRecipe } from "./cache-keepwarm.js";

// Only the runtime is fake: the actor, registry and reducer a refresh reports into are the real ones.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Ten in the morning where the CLI runs: far enough from midnight that only the midnight case meets it.
const T0 = nextPromptDayAt(Date.UTC(2026, 8, 23, 12)) + 10 * 60 * 60_000;
const ID = "c1";

const PRINT: PromptFingerprint = { hash: "h1", parts: { version: "1.0.0", model: "claude-opus-5-5", system: "s1", day: "2026-09-24", tools: "t1" } };

const recipe = (over: Partial<WarmRecipe> = {}): WarmRecipe => ({
    request: {
        spec: { prompt: "the last turn's words", cwd: WORKSPACE_ROOT, conversationId: ID, model: "claude-opus-5-5" },
        policy: {},
        tools: {},
        hooks: {} as HarnessRequest["hooks"],
        credential: { kind: "claude-oauth", token: "stale-token" },
        signal: new AbortController().signal,
    },
    account: "acct",
    sessionId: "s-1",
    fingerprint: PRINT,
    ...over,
});

interface Harness {
    readonly deps: Services;
    readonly sent: HarnessRequest[];
    readonly rows: Omit<UsageTurn, "at" | "day">[];
}

// The frames a refresh hears, stopping where its own signal says it was cut off.
const harness = (frames: readonly AgentEvent[], opts: { usage?: AccountUsage; keepWarm?: boolean } = {}): Harness => {
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
        claudeStore: { read: async (id: string) => ({ id, label: id, connectedAt: 0, accessToken: `fresh-${id}` }) },
        headroom: { read: async () => (opts.usage === undefined ? {} : { acct: opts.usage }) } as unknown as Services["headroom"],
        sandboxSettings: { get: async () => SandboxSettingsSchema.parse({ keepWarm: opts.keepWarm ?? false }) },
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
        expect(armKeepWarm(deps, ID, T0 + 4 * HOUR, false, T0 + MINUTE)).toEqual({ refused: expect.stringContaining("Nothing to keep warm") });
    });

    test("is refused once the cache has already expired", async () => {
        const { deps } = harness([]);
        await settled(deps);
        noteReplay(deps.conversations, ID, recipe());
        expect(armKeepWarm(deps, ID, T0 + 4 * HOUR, false, T0 + HOUR + MINUTE)).toEqual({ refused: expect.stringContaining("already cold") });
    });

    test("cuts `until` to what refreshing can honestly keep", async () => {
        const { deps } = harness([]);
        await settled(deps);
        noteReplay(deps.conversations, ID, recipe());
        expect(armKeepWarm(deps, ID, T0 + 12 * HOUR, false, T0 + MINUTE)).toEqual({ ok: true });
        // An hour's entry, nine refreshes fifty minutes apart, and midnight still fourteen hours away.
        expect(hold(deps)?.until).toBe(T0 + HOUR + 9 * 50 * MINUTE);
    });

    test("counts the refreshes a live hold already spent, so re-arming cannot outrun them", async () => {
        const { deps } = harness([]);
        await settled(deps);
        noteReplay(deps.conversations, ID, recipe());
        armKeepWarm(deps, ID, T0 + 2 * HOUR, false, T0 + MINUTE);
        const last = T0 + 150 * MINUTE;
        for (const at of [T0 + 50 * MINUTE, T0 + 100 * MINUTE, last]) {
            deps.conversations.send(ID, { kind: "keep-warm-refreshed", at, ttlMs: HOUR, readTokens: 1 });
        }
        armKeepWarm(deps, ID, T0 + 20 * HOUR, false, last + MINUTE);
        expect(hold(deps)?.until).toBe(last + HOUR + 6 * 50 * MINUTE);
    });

    test("tells every card the conversation can be kept at all", async () => {
        const { deps } = harness([]);
        await settled(deps);
        noteReplay(deps.conversations, ID, recipe());
        expect(deps.agents.get(ID)?.promptCache).toEqual({ at: T0, ttlMs: HOUR, rollsAt: nextPromptDayAt(T0), keepable: true });
    });
});

describe("tending a hold", () => {
    const armed = async (frames: readonly AgentEvent[], opts: Parameters<typeof harness>[1] = {}): Promise<Harness> => {
        const built = harness(frames, opts);
        await settled(built.deps);
        noteReplay(built.deps.conversations, ID, recipe());
        armKeepWarm(built.deps, ID, T0 + 4 * HOUR, false, T0 + MINUTE);
        return built;
    };

    test("waits while the cache has time to spare", async () => {
        const { deps, sent } = await armed(refreshed(T0 + 30 * MINUTE));
        await tendKeepWarm(deps, ID, T0 + 30 * MINUTE);
        expect(sent).toHaveLength(0);
        expect(hold(deps)?.refreshes).toBe(0);
    });

    test("replays the last turn's request as a forked refresh once it is due, and restarts the clock", async () => {
        const { deps, sent, rows } = await armed(refreshed(T0 + 51 * MINUTE));
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        const [request] = sent;
        expect(request?.policy.keepWarm).toBe(true);
        expect(request?.spec.prompt).toBe(KEEP_WARM_PROMPT);
        expect(request?.spec.sessionId).toBe("s-1");
        expect(request?.spec.conversationId).toBeUndefined();
        expect(request?.credential).toEqual({ kind: "claude-oauth", token: "fresh-acct" });
        expect(hold(deps)).toEqual({ since: T0 + MINUTE, until: T0 + 4 * HOUR, refreshes: 1, readTokens: 198_000 });
        expect(deps.conversations.state(ID)?.turn.promptCache).toEqual({ at: T0 + 51 * MINUTE, ttlMs: HOUR });
        expect(rows).toEqual([expect.objectContaining({ purpose: "keep-warm", conversationId: ID, account: "acct", cacheReadTokens: 198_000 })]);
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
        expect(hold(deps)?.ended?.reason).toBe("rewrote");
    });

    test("ends when the provider refuses the refresh for the account's limit", async () => {
        const { deps } = await armed([{ kind: "error", code: "rate_limit", message: "You've hit your session limit" }, { kind: "done" }]);
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(hold(deps)?.ended).toEqual({ at: T0 + 51 * MINUTE, reason: "limited", detail: "You've hit your session limit" });
    });

    test("ends without sending anything once the account is past its reserve", async () => {
        const usage: AccountUsage = { measuredAt: T0, windows: [{ kind: "five_hour", utilization: 90, gates: "all" }] };
        const { deps, sent } = await armed(refreshed(T0 + 51 * MINUTE), { usage });
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(sent).toHaveLength(0);
        expect(hold(deps)?.ended).toEqual({ at: T0 + 51 * MINUTE, reason: "allowance", detail: "90%" });
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
        expect(hold(deps)?.ended?.reason).toBe("midnight");
    });

    test("ends when the conversation has moved to another session", async () => {
        const { deps } = await armed([]);
        noteReplay(deps.conversations, ID, recipe({ sessionId: "s-2" }));
        await tendKeepWarm(deps, ID, T0 + 51 * MINUTE);
        expect(hold(deps)?.ended?.reason).toBe("moved");
    });

    test("a stop press clears the hold", async () => {
        const { deps } = await armed([]);
        dropKeepWarm(deps, ID);
        expect(hold(deps)).toBeUndefined();
    });
});

describe("the sandbox-wide setting", () => {
    test("arms after a turn a person asked for, on a conversation large enough to be worth it", async () => {
        const { deps } = harness([], { keepWarm: true });
        await settled(deps);
        noteReplay(deps.conversations, ID, recipe());
        await autoKeepWarm(deps, { conversationId: ID, actor: "me@example.com", failure: undefined }, T0 + MINUTE);
        expect(hold(deps)?.auto).toBe(true);
    });

    test("leaves a turn the sandbox started alone", async () => {
        const { deps } = harness([], { keepWarm: true });
        await settled(deps);
        noteReplay(deps.conversations, ID, recipe());
        await autoKeepWarm(deps, { conversationId: ID, actor: undefined, failure: undefined }, T0 + MINUTE);
        expect(hold(deps)).toBeUndefined();
    });

    test("does nothing while the setting is off", async () => {
        const { deps } = harness([]);
        await settled(deps);
        noteReplay(deps.conversations, ID, recipe());
        await autoKeepWarm(deps, { conversationId: ID, actor: "me@example.com", failure: undefined }, T0 + MINUTE);
        expect(hold(deps)).toBeUndefined();
    });
});

import { AgentSummarySchema, AgentTurnSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import {
    conversationIdFor,
    exitOfRun,
    parseRunArgs,
    readCard,
    RUN_POLL_MS,
    RUN_WAIT_DEFAULT_S,
    type RunDeps,
    RunExchangeError,
    runExchange,
    runRequestBody,
    settledOf,
    summaryOfCard,
} from "./run.js";

const env = { INTENTIC_URL: "https://box.example/", INTENTIC_TOKEN: "ict_t" };
const random = () => "abc-123";

test("a prompt and the env's address and token are a call with the defaults; the origin is trimmed to the daemon", () => {
    const parsed = parseRunArgs(["fix", "the", "flaky", "test"], env, random);
    expect(parsed).toEqual({
        kind: "call",
        call: { origin: "https://box.example", token: "ict_t", prompt: "fix the flaky test", conversationId: "ci-abc-123", waitS: RUN_WAIT_DEFAULT_S, land: false },
    });
});

test("options override the env; --land and --agent ride along; --conversation pins the conversation", () => {
    const parsed = parseRunArgs(["--url", "https://other.example/some/path", "--token", "ict_x", "--agent", "codex", "--wait", "60", "--land", "--conversation", "pr-7", "go"], env, random);
    expect(parsed).toEqual({
        kind: "call",
        call: { origin: "https://other.example", token: "ict_x", prompt: "go", conversationId: "pr-7", agent: "codex", waitS: 60, land: true },
    });
});

test("a missing address, a missing token, a bad wait, a bad URL and an unknown option are each refused with their own sentence", () => {
    expect(parseRunArgs(["go"], {}, random)).toEqual({ kind: "error", message: "no sandbox URL: pass --url or set INTENTIC_URL" });
    expect(parseRunArgs(["go"], { INTENTIC_URL: "https://box.example" }, random)).toMatchObject({ kind: "error", message: expect.stringContaining("no control token") });
    expect(parseRunArgs(["--wait", "soon"], env, random)).toEqual({ kind: "error", message: '--wait needs a whole number, not "soon"' });
    expect(parseRunArgs(["--url", "not a url"], env, random)).toEqual({ kind: "error", message: "the URL is not a sandbox address: not a url" });
    expect(parseRunArgs(["--nope"], env, random)).toEqual({ kind: "error", message: "unknown option --nope" });
    expect(parseRunArgs(["--token"], env, random)).toEqual({ kind: "error", message: "--token needs a value" });
    expect(parseRunArgs(["-h"], env, random)).toEqual({ kind: "help" });
});

test("the conversation is one per CI run and attempt, and random outside a runner", () => {
    expect(conversationIdFor({ GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" }, random)).toBe("ci-123-2");
    expect(conversationIdFor({ GITHUB_RUN_ID: "123" }, random)).toBe("ci-123-1");
    // A hyphen is legal in a conversation id (ConversationIdSchema), so a UUID's survive; anything else is dropped.
    expect(conversationIdFor({}, () => "a1b2-c3d4")).toBe("ci-a1b2-c3d4");
    expect(conversationIdFor({}, () => "a1.b2/c3")).toBe("ci-a1b2c3");
});

// The body this sends is a legal turn as the contract spells it, held against the schema rather than an import.
test("the request body is a valid isolated turn", () => {
    const body = runRequestBody({ origin: "https://box.example", token: "t", prompt: "go", conversationId: "ci-1-1", agent: "codex", waitS: 10, land: false });
    expect(AgentTurnSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ prompt: "go", conversationId: "ci-1-1", isolated: true, agent: "codex" });
});

// The card reader is held against the summary schema the daemon actually answers with.
test("the card reader takes a schema-valid summary and maps every status onto an ending or none", () => {
    const summary = AgentSummarySchema.parse({
        id: "ci-1-1",
        status: "awaiting",
        provider: "claude",
        harness: "native",
        updatedAt: 1,
        branch: "agent/ci-1-1",
        title: "Fix the flaky test",
        attention: { plan: false, question: true, permission: false, capability: false, credential: false, conflict: false },
    });
    const card = readCard(summary);
    expect(card?.status).toBe("awaiting");
    expect(settledOf({ status: "running" })).toBeUndefined();
    expect(settledOf({ status: "resuming" })).toBeUndefined();
    expect(settledOf({ status: "awaiting" })).toBe("parked");
    expect(settledOf({ status: "idle" })).toBe("completed");
    expect(settledOf({ status: "ready" })).toBe("completed");
    expect(settledOf({ status: "error" })).toBe("failed");
    expect(settledOf({ status: "interrupted" })).toBe("failed");
    expect(readCard({ nope: true })).toBeUndefined();
    // The parked summary names the card a person has to open.
    expect(summaryOfCard(card as NonNullable<typeof card>, "parked")).toContain("a question");
    expect(summaryOfCard({ status: "error", failure: "plan spent" }, "failed")).toBe("plan spent");
    expect(summaryOfCard({ status: "idle", title: "Done it" }, "completed")).toBe("Done it");
});

test("the exit is 0 for completed, 1 for parked or failed, 2 for a deadline that decided", () => {
    expect(exitOfRun("completed")).toBe(0);
    expect(exitOfRun("parked")).toBe(1);
    expect(exitOfRun("failed")).toBe(1);
    expect(exitOfRun("timeout")).toBe(2);
});

// A scripted daemon: the calls the exchange makes, in order, with the answers a real one would give.
const scripted = (answers: { readonly cards: readonly object[]; readonly land?: object; readonly startStatus?: number }) => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    let polls = 0;
    let clock = 0;
    const deps: RunDeps = {
        fetch: async (url, init) => {
            calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
            if (url.endsWith("/agent")) {
                const status = answers.startStatus ?? 200;
                return { ok: status < 400, status, text: async () => (status < 400 ? JSON.stringify({ run: "r1" }) : JSON.stringify({ error: "control token not valid for this route" })) };
            }
            if (url.endsWith("/land")) {
                return answers.land === undefined
                    ? { ok: false, status: 403, text: async () => JSON.stringify({ error: "control token not valid for this route" }) }
                    : { ok: true, status: 200, text: async () => JSON.stringify(answers.land) };
            }
            const card = answers.cards[Math.min(polls, answers.cards.length - 1)] as object;
            polls += 1;
            return { ok: true, status: 200, text: async () => JSON.stringify(card) };
        },
        sleep: async (ms) => {
            clock += ms;
        },
        now: () => clock,
    };
    return { deps, calls };
};

const call = { origin: "https://box.example", token: "ict_t", prompt: "go", conversationId: "ci-1-1", waitS: 60, land: false };

test("the exchange starts the turn with the control token, polls the card until it settles, and lands only when asked", async () => {
    const { deps, calls } = scripted({ cards: [{ status: "running" }, { status: "running" }, { status: "ready", title: "Fixed it", branch: "agent/ci-1-1" }] });
    const outcome = await runExchange(call, deps);
    expect(outcome).toEqual({ status: "completed", conversationId: "ci-1-1", branch: "agent/ci-1-1", summary: "Fixed it" });
    expect(calls[0]).toMatchObject({ url: "https://box.example/agent", method: "POST", headers: { "x-intentic-control": "ict_t" } });
    expect(calls.slice(1).every((entry) => entry.url === "https://box.example/agents/ci-1-1" && entry.method === "GET")).toBe(true);
    expect(calls).toHaveLength(4);
});

test("a land is asked for after completion and its answer is the outcome's; a refused land is the wiring's failure", async () => {
    const landed = scripted({ cards: [{ status: "ready", branch: "agent/ci-1-1" }], land: { landed: true } });
    expect((await runExchange({ ...call, land: true }, landed.deps)).landed).toBe(true);
    expect(landed.calls.at(-1)).toMatchObject({ url: "https://box.example/agents/ci-1-1/land", method: "POST" });

    const refused = scripted({ cards: [{ status: "ready" }] });
    await expect(runExchange({ ...call, land: true }, refused.deps)).rejects.toThrow(/land scope/);
});

test("a parked card and a failed card are endings; a refused start is the wiring's failure", async () => {
    const parked = scripted({ cards: [{ status: "awaiting", attention: { plan: true } }] });
    expect(await runExchange(call, parked.deps)).toMatchObject({ status: "parked", summary: expect.stringContaining("a plan") });
    const failed = scripted({ cards: [{ status: "error", failure: "the plan is spent" }] });
    expect(await runExchange(call, failed.deps)).toMatchObject({ status: "failed", summary: "the plan is spent" });
    const refused = scripted({ cards: [], startStatus: 403 });
    await expect(runExchange(call, refused.deps)).rejects.toBeInstanceOf(RunExchangeError);
});

test("the deadline ends the wait with a timeout, and the agent is left working", async () => {
    const { deps, calls } = scripted({ cards: [{ status: "running" }] });
    const outcome = await runExchange({ ...call, waitS: (RUN_POLL_MS * 3) / 1_000 }, deps);
    expect(outcome.status).toBe("timeout");
    expect(outcome.summary).toContain("keeps working");
    // The start, then exactly as many polls as fit in the wait.
    expect(calls).toHaveLength(4);
});

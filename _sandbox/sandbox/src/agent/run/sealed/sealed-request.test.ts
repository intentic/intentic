import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent, RoutedAgentTurn } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { privacySliceFake } from "../../../privacy/privacy-slice.testing.js";
import { tokenOf } from "../../../privacy/tokens.js";
import type { TurnArmPlan, TurnContext } from "../../providers/adapter.js";
import { AgentDomainRefusedError, type AgentExecutionLease } from "../../../workload/agent-execution.js";
import { rootExecution } from "../../../workload/agent-execution.testing.js";
import { runSealedRequest, SEALED_SYSTEM_PROMPT, type SealedAsk } from "./sealed-request.js";

// A helper's request on the turn's own seam: planned by the runtime's arm, run by its loop, read whole by the privacy
// shield, its failures filed by the turn's classifier. The arm and loop are faked here, since each runtime's own suite
// pins how it honours `policy.sealed`; what is under test is the request the runner hands them and how it reads back.

// The national id the shield's own suite masks (privacy-shield.test.ts), written in a diff a helper is asked to describe.
const PESEL = "44051401458";

type Adapter = ReturnType<Services["adapters"]["for"]>;

interface Planned {
    readonly input: RoutedAgentTurn;
    readonly context: TurnContext;
}

// One arm: records what it was asked to plan, and answers with the frames its loop would send.
const arm = (frames: (planned: Planned) => AsyncGenerator<AgentEvent>, refusal?: string) => {
    const planned: Planned[] = [];
    const adapter: Adapter = {
        runtime: "cursor",
        sealed: true,
        preflight: async (_deps, input, context): Promise<TurnArmPlan> => {
            planned.push({ input, context });
            if (refusal !== undefined) {
                return { ok: false, message: refusal };
            }
            const request = { ...context.base, credential: { kind: "cursor-key" as const, apiKey: "key" } };
            return { ok: true, request, account: "cursor-one", run: () => frames({ input, context }) };
        },
        health: unstubbed<Adapter>("adapter", {}).health,
        holdsSession: unstubbed<Adapter>("adapter", {}).holdsSession,
    };
    return { adapter, planned };
};

const services = (adapter: Adapter, policy: Parameters<typeof privacySliceFake>[0] = {}) => {
    const privacy = privacySliceFake(policy);
    const refusals = { record: jest.fn(async () => {}), clear: jest.fn(async () => {}) };
    const observed = { record: jest.fn(async () => {}) };
    const fake = unstubbed<Services>("services", {
        privacyShield: privacy.privacyShield,
        adapters: { for: () => adapter, all: [adapter] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
        cards: unstubbed<Services["cards"]>("cards", {}),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", refusals),
        observedLimits: unstubbed<Services["observedLimits"]>("observedLimits", observed),
        headroom: unstubbed<Services["headroom"]>("headroom", { refresh: async () => undefined }),
        claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { clear: async () => {} }),
        modelCooldowns: unstubbed<Services["modelCooldowns"]>("modelCooldowns", { clear: async () => {} }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
    });
    return { fake, refusals, observed, ledger: privacy.privacyLedger };
};

// Every request runs under an issued execution context (workload/agent-execution.ts), here the workspace's own view.
let lease: AgentExecutionLease;
beforeEach(() => {
    lease = rootExecution({ localCwd: WORKSPACE_ROOT });
});
afterEach(() => {
    lease.release();
});

const ask = (fields: Partial<SealedAsk> = {}): SealedAsk => ({
    execution: lease.context,
    provider: "cursor",
    harness: "claude-code",
    model: "composer-2.5",
    prompt: "Write a commit subject for this diff.",
    signal: new AbortController().signal,
    ...fields,
});

async function* saying(...texts: string[]): AsyncGenerator<AgentEvent> {
    yield { kind: "session", sessionId: "s-1" };
    for (const text of texts) {
        yield { kind: "delta", text };
    }
    yield { kind: "done" };
}

test("plans a sealed request on the runtime's own arm and answers with what its loop said", async () => {
    const { adapter, planned } = arm(async function* () {
        yield* saying("fix: tighten ", "the tree truncation\n");
    });
    const { fake, refusals } = services(adapter);

    await expect(runSealedRequest(fake, ask({ conversationId: "vivid-rowan-moks", effort: "low" }))).resolves.toBe("fix: tighten the tree truncation");

    const [first] = planned;
    if (first === undefined) {
        throw new Error("nothing was planned");
    }
    const { input, context } = first;
    expect(input).toEqual({
        prompt: "Write a commit subject for this diff.",
        agent: "cursor",
        harness: "claude-code",
        model: "composer-2.5",
        effort: "low",
        conversationId: "vivid-rowan-moks",
    });
    expect(context.base.execution).toBe(lease.context);
    expect(context.base.policy).toEqual({ sealed: true });
    expect(context.base.tools).toEqual({});
    expect(context.base.spec).toEqual({
        prompt: "Write a commit subject for this diff.",
        cwd: WORKSPACE_ROOT,
        model: "composer-2.5",
        effort: "low",
        systemPromptMode: "custom",
        systemPrompt: SEALED_SYSTEM_PROMPT,
    });
    // No conversation is made for it, whoever it is for: nothing in the request files under one.
    expect(Object.keys(context.base.spec)).not.toContain("conversationId");
    expect(context.attachmentPaths).toEqual([]);
    // Its words on the wire settle what Cursor last refused on that account, as a turn's do.
    expect(refusals.clear).toHaveBeenCalledWith("cursor", "cursor-one");
});

test("runs in the issued context's view, not wherever the workspace happens to be", async () => {
    const { adapter, planned } = arm(async function* () {
        yield* saying("fix: tighten the tree truncation");
    });
    const view = rootExecution({ localCwd: `${WORKSPACE_ROOT}/helper-view` });
    try {
        await expect(runSealedRequest(services(adapter).fake, ask({ execution: view.context }))).resolves.toBe("fix: tighten the tree truncation");
        const context = planned[0]?.context;
        expect(context?.base.execution).toBe(view.context);
        expect([context?.base.spec.cwd, context?.localCwd, context?.effectiveCwd]).toEqual([
            `${WORKSPACE_ROOT}/helper-view`, `${WORKSPACE_ROOT}/helper-view`, `${WORKSPACE_ROOT}/helper-view`,
        ]);
    } finally {
        view.release();
    }
});

test.each(["released", "forged"] as const)("a %s execution context is refused before the shield reads it or any arm plans it", async (kind) => {
    const execution = kind === "forged" ? { mode: "root" as const, cwd: WORKSPACE_ROOT } : lease.context;
    if (kind === "released") {
        lease.release();
    }
    const pending = runSealedRequest(unstubbed<Services>("nothing may be touched", {}), ask({ execution }));
    await expect(pending).rejects.toBeInstanceOf(AgentDomainRefusedError);
    await expect(pending).rejects.toMatchObject({ code: "agent-domain-refused", message: "Agent execution context is not registered or has been released." });
});

test("a context released while the shield reads the request is refused before any arm plans it", async () => {
    const { adapter, planned } = arm(async function* () {
        yield* saying("never asked");
    });
    const { fake } = services(adapter);
    const guarded = unstubbed<Services>("services", {
        ...fake,
        privacyShield: unstubbed<Services["privacyShield"]>("privacyShield", {
            seal: async (request) => {
                lease.release();
                return { prompt: request.prompt, restore: (text: string) => text };
            },
        }),
    });
    await expect(runSealedRequest(guarded, ask())).rejects.toMatchObject({ code: "agent-domain-refused" });
    expect(planned).toEqual([]);
});

test("a subagent's words are not the answer", async () => {
    const { adapter } = arm(async function* () {
        yield { kind: "delta", text: "reading the diff", parentToolUseId: "task-1" };
        yield* saying("docs: name the shield's sealed path");
    });
    await expect(runSealedRequest(services(adapter).fake, ask())).resolves.toBe("docs: name the shield's sealed path");
});

// The bug this runner exists to fix: Composer refused for its runtime while nothing in the diff was personal.
test("on a runtime the gateway can't cover, the shield masks what the prompt holds and the answer reads back", async () => {
    const { adapter, planned } = arm(async function* ({ input }) {
        yield* saying(input.prompt.includes(tokenOf("NATIONAL_ID", 1)) ? `test: fixture for ${tokenOf("NATIONAL_ID", 1)}` : "unmasked");
    });
    const { fake, ledger } = services(adapter, { policy: { mode: "on" } });

    await expect(runSealedRequest(fake, ask({ prompt: `diff: add PESEL ${PESEL}` }))).resolves.toBe(`test: fixture for ${PESEL}`);
    expect(planned[0]?.input.prompt).toBe(`diff: add PESEL ${tokenOf("NATIONAL_ID", 1)}`);
    expect(planned[0]?.context.base.spec.prompt).toBe(`diff: add PESEL ${tokenOf("NATIONAL_ID", 1)}`);
    expect(ledger.entries).toEqual([expect.objectContaining({ provider: "cursor", action: "masked", protocol: "sealed", counts: { "national-id": 1 } })]);
});

test("a runtime that does not declare the sealed profile is never handed one", async () => {
    const { adapter, planned } = arm(async function* () {
        yield* saying("never");
    });
    const unsealed: Adapter = { runtime: adapter.runtime, preflight: adapter.preflight, health: adapter.health, holdsSession: adapter.holdsSession };
    await expect(runSealedRequest(services(unsealed).fake, ask())).rejects.toThrow("cursor runs no helper, so there is nothing to ask it one line with.");
    expect(planned).toEqual([]);
});

test("an arm's refusal is the failure, in its own words", async () => {
    const { adapter } = arm(async function* () {
        yield* saying("never");
    }, "Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor.");
    await expect(runSealedRequest(services(adapter).fake, ask())).rejects.toThrow("Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor.");
});

// Filed the way a turn's spent allowance is, so the next request's account choice reads this one out of Composer.
test("a spent allowance is filed by the turn's classifier against its account and model, then thrown as the provider said it", async () => {
    const { adapter } = arm(async function* () {
        yield { kind: "error", code: "rate_limit", message: "You've hit your usage limit for Composer.", resetsAt: 1_900_000_000 };
        yield { kind: "done" };
    });
    const { fake, refusals, observed } = services(adapter);

    await expect(runSealedRequest(fake, ask())).rejects.toThrow("You've hit your usage limit for Composer.");
    expect(refusals.record).toHaveBeenCalledWith("cursor", expect.objectContaining({ kind: "limit", account: "cursor-one", model: "composer-2.5" }));
    expect(observed.record).toHaveBeenCalledWith("cursor", "cursor-one", "composer-2.5", expect.objectContaining({ message: "You've hit your usage limit for Composer." }));
    // Nothing was said, so nothing was settled.
    expect(refusals.clear).not.toHaveBeenCalled();
});

test("a retry deferred past a helper's patience ends it; a brief one is waited out", async () => {
    const deferred = arm(async function* () {
        yield { kind: "provider_retry", attempt: 1, maxAttempts: 10, nextAttemptAt: Date.now() + 60_000 };
        yield* saying("too late");
    });
    await expect(runSealedRequest(services(deferred.adapter).fake, ask())).rejects.toThrow(/retry deferred 60s/);

    const brief = arm(async function* () {
        yield { kind: "provider_retry", attempt: 1, maxAttempts: 10, nextAttemptAt: Date.now() + 500 };
        yield* saying("Sandbox freezes · fix");
    });
    await expect(runSealedRequest(services(brief.adapter).fake, ask())).resolves.toBe("Sandbox freezes · fix");
});

test("a loop that ends without a word fails rather than answering empty", async () => {
    const { adapter } = arm(async function* () {
        yield* saying("   ");
    });
    await expect(runSealedRequest(services(adapter).fake, ask())).rejects.toThrow("the model did not answer");
});

test("the caller's cancel stops the loop, and what it threw is not dressed as the deadline", async () => {
    const caller = new AbortController();
    const { adapter } = arm(async function* ({ context }) {
        yield { kind: "session", sessionId: "s-1" };
        caller.abort();
        // The loop runs under the runner's own signal, which the caller's cancel ends.
        expect(context.base.signal.aborted).toBe(true);
        throw new Error("aborted");
    });
    await expect(runSealedRequest(services(adapter).fake, ask({ signal: caller.signal }))).rejects.toThrow(/^aborted$/);
});

// Two Cursor accounts behind one arm that picks the first one the filed limits leave room on, as cursorAccountForTurn
// does; the frames say whether that account still has Composer.
const fleet = (spentOn: readonly string[]) => {
    const asked: string[] = [];
    const filed = new Set<string>();
    const adapter: Adapter = {
        runtime: "cursor",
        sealed: true,
        preflight: async (_deps, _input, context): Promise<TurnArmPlan> => {
            const account = ["one", "two"].find((candidate) => !filed.has(candidate)) ?? "one";
            const request = { ...context.base, credential: { kind: "cursor-key" as const, apiKey: `key-${account}` } };
            return {
                ok: true,
                request,
                account,
                async *run () {
                    asked.push(account);
                    if (spentOn.includes(account)) {
                        yield { kind: "error", code: "rate_limit", message: "429 usage limit reached", resetsAt: 1_900_000_000 };
                    } else {
                        yield* saying("fix: tree truncation");
                    }
                },
            };
        },
        health: unstubbed<Adapter>("adapter", {}).health,
        holdsSession: unstubbed<Adapter>("adapter", {}).holdsSession,
    };
    const built = services(adapter);
    built.observed.record.mockImplementation(async (...args: unknown[]) => {
        filed.add(String(args[1]));
    });
    return { ...built, asked };
};

// The commit-message bug: the first account is out of Composer, and the allowance on the other went unused.
test("a spent allowance on one account is filed before the arm plans again, and the sibling answers", async () => {
    const { fake, asked } = fleet(["one"]);
    await expect(runSealedRequest(fake, ask())).resolves.toBe("fix: tree truncation");
    expect(asked).toEqual(["one", "two"]);
});

test("a fleet entirely out of the model refuses in the vendor's own words, having asked each account once", async () => {
    const { fake, asked } = fleet(["one", "two"]);
    await expect(runSealedRequest(fake, ask())).rejects.toThrow("429 usage limit reached");
    expect(asked).toEqual(["one", "two"]);
});

test("any other refusal is not a reason to plan again", async () => {
    const { adapter, planned } = arm(async function* () {
        yield { kind: "error", message: "Connect your Cursor account again in Sandbox ▸ Agent." };
    });
    await expect(runSealedRequest(services(adapter).fake, ask())).rejects.toThrow("Connect your Cursor account again in Sandbox ▸ Agent.");
    expect(planned).toHaveLength(1);
});

import type { AgentTurn } from "@intentic/sandbox-contract";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import type { AgentRequest } from "./agent.js";
import { planTurn, type TurnContext } from "./turn-plan.js";

/* WHAT A TURN IS ALLOWED TO RUN ON, and what it is handed once it may. Every case here used to be reachable
 * only through app.test.ts booting the whole daemon, which is why the four provider arms drifted apart in the
 * first place — each learned the same lessons separately (resolve a concrete model, or the SDK's own retired
 * default gets used; refuse a dead session id up front, or the CLI spawns just to fail opaquely).
 *
 * A refusal is a VALUE here, so the gates are assertable without a stream: `ok: false` plus the machine-readable
 * code the composer's connect gate keys off. */

const credentials = vi.fn<() => Promise<Record<string, unknown>>>();
vi.mock("./harness-credentials.js", () => ({ resolveHarnessCredentials: () => credentials() }));

const base: AgentRequest = { prompt: "do the thing", cwd: "/work", signal: new AbortController().signal };
const context: TurnContext = {
    base,
    attachmentPaths: [],
    localCwd: "/work",
    effectiveCwd: "/work",
    cliEnv: {},
    syncNote: undefined,
    steering: undefined,
};

// Only the seams a given arm actually reaches for matter; each test overrides what its own gate reads.
const servicesWith = (overrides: Record<string, unknown>): Services =>
    ({
        tools: [],
        workspace: { root: "/work" },
        capabilities: { list: async () => [] },
        config: { translator: { url: "", token: "" }, openaiApiKey: "", iqPluginDir: "", intenticAgentModel: "" },
        cliProxy: { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }) },
        codexAgent: async function* () {},
        grokAgent: async function* () {},
        agent: async function* () {},
        acpAgent: async function* () {},
        ...overrides,
    }) as unknown as Services;

const turn = (overrides?: Partial<AgentTurn>): AgentTurn => ({ prompt: "do the thing", ...overrides }) as AgentTurn;

beforeEach(() => {
    credentials.mockReset();
    credentials.mockResolvedValue({ ok: true, credentials: { oauthToken: "sk-oauth", account: "acc-1" } });
});

// --- the gates: each refuses for an ordinary state of a sandbox, and says which one -----------------------

test("a Codex thread that no longer exists is refused by code, so the client can drop the dead id", async () => {
    const services = servicesWith({ codexThreadExists: async () => false });

    const plan = await planTurn(services, turn({ agent: "codex", sessionId: "thread-gone" }), context);

    expect(plan.ok).toBe(false);
    expect(plan).toMatchObject({ code: "session-not-found" });
});

test("Codex with neither a translator subscription nor an api key names which of the two is missing", async () => {
    const noImage = await planTurn(servicesWith({ codexThreadExists: async () => true }), turn({ agent: "codex" }), context);
    expect(noImage).toMatchObject({ ok: false, code: "subscription-required" });
    // A sandbox with no translator at all can't be fixed by connecting anything, so it must not say "connect".
    expect((noImage as { message: string }).message).toContain("no model translator");

    const unconnected = servicesWith({
        codexThreadExists: async () => true,
        config: { translator: { url: "http://127.0.0.1:8788", token: "local" }, openaiApiKey: "" },
    });
    const plan = await planTurn(unconnected, turn({ agent: "codex" }), context);
    expect(plan).toMatchObject({ ok: false, code: "subscription-required" });
    expect((plan as { message: string }).message).toContain("Connect your ChatGPT subscription");
});

test("Grok with no xAI sign-in is refused before a turn spawns", async () => {
    const services = servicesWith({ openCode: { connected: async () => false } });

    const plan = await planTurn(services, turn({ agent: "grok" }), context);

    expect(plan.ok).toBe(false);
    expect((plan as { message: string }).message).toContain("No Grok account connected");
});

// The gate every other arm had and this one didn't: OpenCode answers a dead session id with a rejection that
// names nothing, so the chat kept re-sending it. The code is what lets the client drop it.
test("a Grok session OpenCode no longer holds is refused by code, not re-sent forever", async () => {
    const services = servicesWith({ openCode: { connected: async () => true, sessionExists: async () => false } });

    const plan = await planTurn(services, turn({ agent: "grok", sessionId: "ses-gone" }), context);

    expect(plan).toMatchObject({ ok: false, code: "session-not-found" });
});

test("an ACP provider whose capability is gone is refused by name", async () => {
    const services = servicesWith({ capabilities: { list: async () => [{ kind: "agent", id: "other-agent", config: {} }] } });

    const plan = await planTurn(services, turn({ agent: "gemini-cli" }), context);

    expect(plan.ok).toBe(false);
    expect((plan as { message: string }).message).toContain(`Unknown agent provider "gemini-cli"`);
});

test("a harness refusal rides through with the credential resolver's own code", async () => {
    credentials.mockResolvedValue({ ok: false, code: "claude-reauth", message: "Your Claude sign-in expired." });

    const plan = await planTurn(servicesWith({}), turn(), context);

    expect(plan).toMatchObject({ ok: false, code: "claude-reauth", message: "Your Claude sign-in expired." });
});

test("a Claude session id the sandbox no longer holds is refused by code, not spawned and failed", async () => {
    const services = servicesWith({ sessions: { exists: async () => false } });

    const plan = await planTurn(services, turn({ sessionId: "s-gone" }), context);

    expect(plan).toMatchObject({ ok: false, code: "session-not-found" });
});

// --- what a permitted turn is handed ----------------------------------------------------------------------

/* Both native arms resolve a CONCRETE model rather than letting their SDK pick, and for the same reason twice
 * over: @openai/codex-sdk defaults to gpt-5-codex (which a subscription can reject) and OpenCode defaults to a
 * retired models.dev id xAI rejects outright. An omitted model is the common case — the client drops an empty
 * selection from the wire so the daemon resolves its own catalog default. */

test("Codex resolves the catalog default when the turn pins no model", async () => {
    const services = servicesWith({
        codexThreadExists: async () => true,
        config: { translator: { url: "http://127.0.0.1:8788", token: "local" }, openaiApiKey: "" },
        cliProxy: { accounts: async () => ({ codex: ["sub"], grok: [], kimi: [], gemini: [] }) },
        codexModels: { models: async () => ({ default: "gpt-5.6-codex" }) },
    });

    const plan = await planTurn(services, turn({ agent: "codex" }), context);

    expect(plan).toMatchObject({ ok: true, account: "codex-subscription" });
    expect((plan as { request: AgentRequest }).request.model).toBe("gpt-5.6-codex");
});

test("Grok replaces a model its live catalog no longer offers, and keeps one it does", async () => {
    const services = servicesWith({
        openCode: {
            connected: async () => true,
            xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4" }, { id: "grok-4-fast" }] }),
        },
    });

    const retired = await planTurn(services, turn({ agent: "grok", model: "grok-code-fast-1" }), context);
    expect((retired as { request: AgentRequest }).request.model).toBe("grok-4");

    const offered = await planTurn(services, turn({ agent: "grok", model: "grok-4-fast" }), context);
    expect((offered as { request: AgentRequest }).request.model).toBe("grok-4-fast");
    // OpenCode holds one xAI auth, so every Grok turn attributes to the same account.
    expect(offered).toMatchObject({ account: "xai" });
});

// The harness arm is the deep one — it reaches settings, plugins, browser profiles and the workspace probe —
// so it needs the seams those touch before it can be planned at all.
const harnessServices = (overrides?: Record<string, unknown>): Services =>
    servicesWith({
        workspace: { root: "/work" },
        processes: { running: () => false, run: async () => ({ stdout: "", stderr: "", code: 0 }) },
        extensions: { list: async () => [] },
        sessions: { exists: async () => true },
        sandboxSettings: { get: async () => ({ systemPromptMode: "preset", systemPrompt: "", outputCleaners: "", filterBackend: "native" }) },
        openCode: { connected: async () => false },
        codexHome: "/root/.codex",
        authRoot: "/root/.local/share",
        ...overrides,
    });

test("the account the credential resolver answered with becomes the turn's attribution key", async () => {
    const plan = await planTurn(harnessServices(), turn(), context);

    expect(plan).toMatchObject({ ok: true, account: "acc-1" });
});

/* Delegation is offered only where the credential to act on it exists. An agent told in its system prompt that
 * it may shell out to Codex, whose Bash then has no CODEX_HOME, burns a tool call discovering that — so the note
 * and the env are one decision, made together. */
test("no reachable Codex means neither the delegation env nor the note that promises it", async () => {
    const plan = await planTurn(harnessServices(), turn(), context);

    expect((plan as { request: AgentRequest }).request.cliEnv?.["CODEX_HOME"]).toBeUndefined();
    expect((plan as { request: AgentRequest }).request.systemAppend ?? "").not.toContain("codex");
});

test("a translator holding the ChatGPT subscription puts CODEX_HOME and the bearer in the agent's shell", async () => {
    const plan = await planTurn(
        harnessServices({
            config: { translator: { url: "http://127.0.0.1:8788", token: "local" }, openaiApiKey: "", iqPluginDir: "", intenticAgentModel: "" },
            cliProxy: { accounts: async () => ({ codex: ["sub"], grok: [], kimi: [], gemini: [] }) },
        }),
        turn(),
        context,
    );

    expect((plan as { request: AgentRequest }).request.cliEnv).toMatchObject({ CODEX_HOME: "/root/.codex", CODEX_API_KEY: "local" });
});

// --- what the runtime's declared record takes off the request ---------------------------------------------

/* The composer offers every permission mode to every provider, because until an adapter is running there is
 * nothing to ask. What must NOT happen is the request carrying a posture the adapter then drops on the floor:
 * that is how "Ask before each file edit" came to sit above a runtime whose every tool call is pre-approved,
 * and how the turn journal came to record it. A `plan` runtime keeps plan and nothing else. */
const codexServices = (overrides?: Record<string, unknown>): Services =>
    servicesWith({
        codexThreadExists: async () => true,
        config: { translator: { url: "http://127.0.0.1:8788", token: "local" }, openaiApiKey: "" },
        cliProxy: { accounts: async () => ({ codex: ["sub"], grok: [], gemini: [] }) },
        codexModels: { models: async () => ({ default: "gpt-5.6-codex" }) },
        ...overrides,
    });

// The route has already folded the turn's posture into the request by the time an arm is picked, so these are
// context edits rather than turn edits — the same shape planTurn sees in production.
const asking = (overrides: Partial<AgentRequest>): TurnContext => ({ ...context, base: { ...base, ...overrides } });

test("a plan-only runtime keeps `plan` and is handed no other permission mode", async () => {
    const asked = await planTurn(codexServices(), turn({ agent: "codex" }), asking({ permissionMode: "acceptEdits" }));
    expect((asked as { request: AgentRequest }).request.permissionMode).toBeUndefined();

    const planning = await planTurn(codexServices(), turn({ agent: "codex" }), asking({ permissionMode: "plan" }));
    expect((planning as { request: AgentRequest }).request.permissionMode).toBe("plan");
});

test("the Claude Code loop keeps every mode — it is the runtime that honours them", async () => {
    const plan = await planTurn(harnessServices(), turn(), asking({ permissionMode: "acceptEdits" }));

    expect((plan as { request: AgentRequest }).request.permissionMode).toBe("acceptEdits");
});

// Codex forwards reasoning effort (modelReasoningEffort); OpenCode takes a model id and a prompt and nothing
// else, so an effort riding a Grok request is a value nobody reads.
test("effort reaches the runtimes that forward it and no others", async () => {
    const codex = await planTurn(codexServices(), turn({ agent: "codex" }), asking({ effort: "high" }));
    expect((codex as { request: AgentRequest }).request.effort).toBe("high");

    const grokServices = servicesWith({
        openCode: { connected: async () => true, xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4" }] }) },
    });
    const grok = await planTurn(grokServices, turn({ agent: "grok" }), asking({ effort: "high" }));
    expect((grok as { request: AgentRequest }).request.effort).toBeUndefined();
});

/* A runtime that can't enter the turn's mount namespace is cwd'd into its worktree and nothing more, so an
 * absolute /work path from a memory or an AGENTS.md reaches the SHARED checkout. The note is the only layer
 * left that can keep it inside its own branch — see turn-preamble.ts on why it is second-best. */
test("a cwd-isolated runtime is told where its worktree is; a namespaced one needs no telling", async () => {
    const isolated: TurnContext = { ...context, localCwd: "/history/worktrees/abc/work", effectiveCwd: "/history/worktrees/abc/work" };

    const codex = await planTurn(codexServices(), turn({ agent: "codex" }), isolated);
    const prompt = (codex as { request: AgentRequest }).request.prompt;
    expect(prompt).toContain("/history/worktrees/abc/work");
    expect(prompt).toContain("do the thing");

    const claude = await planTurn(harnessServices(), turn(), isolated);
    expect((claude as { request: AgentRequest }).request.prompt).not.toContain("Where this turn's files live");
});

test("a main-tree turn has no worktree to name, so it says nothing", async () => {
    const plan = await planTurn(codexServices(), turn({ agent: "codex" }), context);

    expect((plan as { request: AgentRequest }).request.prompt).toBe("do the thing");
});

/* The pre-turn rebase moved the files under whichever model is about to read them, so the note cannot live in
 * one arm — honoured() is the only point all four pass through, and this is what proves it. */
test("every runtime hears that its branch was rebased; a main-tree turn has no branch to rebase", async () => {
    const isolated: TurnContext = {
        ...context,
        localCwd: "/history/worktrees/abc/work",
        effectiveCwd: "/history/worktrees/abc/work",
        syncNote: "## Your branch moved onto newer main\n\nrebased onto 3 commits",
    };

    for (const plan of [
        await planTurn(harnessServices(), turn(), isolated),
        await planTurn(codexServices(), turn({ agent: "codex" }), isolated),
    ]) {
        const prompt = (plan as { request: AgentRequest }).request.prompt;
        expect(prompt).toContain("Your branch moved onto newer main");
        expect(prompt).toContain("do the thing");
    }

    const main = await planTurn(codexServices(), turn({ agent: "codex" }), { ...context, syncNote: "should never be sent" });
    expect((main as { request: AgentRequest }).request.prompt).toBe("do the thing");
});

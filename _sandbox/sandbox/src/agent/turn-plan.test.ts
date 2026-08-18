import { tmpdir } from "node:os";
import { HISTORY_ROOT } from "@intentic/constants";
import { type AgentTurn, type Persona, type SandboxSettings, PersonaPowersSchema, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { testConfig } from "../testing.js";
import type { AgentRequest } from "./agent.js";
import { conversationExperimentArm, planTurn, type TurnContext } from "./turn-plan.js";

/* WHAT A TURN IS ALLOWED TO RUN ON, and what it is handed once it may. Every case here used to be reachable
 * only through app.test.ts booting the whole daemon, which is why the four provider arms drifted apart in the
 * first place — each learned the same lessons separately (resolve a concrete model, or the SDK's own retired
 * default gets used). Which session a turn may resume is NOT among them: it is one rule for all four runtimes
 * and lives with the route that acts on it (app.integration.test.ts covers it end to end).
 *
 * A refusal is a VALUE here, so the gates are assertable without a stream: `ok: false` plus the machine-readable
 * code the composer's connect gate keys off. */

const credentials = vi.fn<() => Promise<Record<string, unknown>>>();
vi.mock("./harness-credentials.js", () => ({ resolveHarnessCredentials: () => credentials() }));
const browserServers = vi.fn();
vi.mock("../browser/browser-tools.js", () => ({ browserServersOf: (...args: unknown[]) => browserServers(...args) }));

/* A workspace root that is not on disk, which is the whole point of it: planTurn probes the tree for
 * uninstalled dependencies before it dispatches (see honoured), and a root that exists would make every prompt
 * assertion below depend on whatever happens to be checked out on the machine running the suite. A root with
 * nothing in it discovers no projects and therefore earns no notice. That the notice DOES reach every arm is
 * asserted where a real tree can be built — turn-plan.integration.test.ts. */
const ROOT = "/nowhere/turn-plan";
const IQ_PLUGIN_DIR = new URL("../../../../_search/iq/plugin/", import.meta.url).pathname;

const base: AgentRequest = { prompt: "do the thing", cwd: ROOT, signal: new AbortController().signal };
const context: TurnContext = {
    base,
    attachmentPaths: [],
    localCwd: ROOT,
    effectiveCwd: ROOT,
    cliEnv: {},
    steering: undefined,
};

// Only the seams a given arm actually reaches for matter; each test overrides what its own gate reads, and
// every seam it doesn't name answers with its own name rather than `undefined`.
const servicesWith = (overrides: Partial<Services> = {}): Services =>
    unstubbed<Services>("services", {
        tools: [],
        workspace: unstubbed<Services["workspace"]>("workspace", { root: ROOT }),
        processes: unstubbed<Services["processes"]>("processes", { running: () => false }),
        dependencies: unstubbed<Services["dependencies"]>("dependencies", { status: async () => [], issueAt: async () => undefined }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        // Read on every turn, not only a pinned one: an unattended wake that named no persona is exactly the
        // case whose answer must be "no accounts", so the read cannot be conditional on there being one.
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [] }),
        // A measurement seam, not a behavioural one — the planning steps file their own spans so a slow turn
        // names the step rather than the phase. Pass the work through and time nothing.
        perf: unstubbed<Services["perf"]>("perf", { track: (_op, _fields, run) => run() }),
        /* The schema's own defaults, which is what a workspace that has never written a settings file reads.
         *
         * Here rather than only in the harness fixture below, because settings are read ABOVE the provider
         * split now: everything about a turn's instructions is composed once for every runtime, and that
         * composition needs them. A turn that is about to be refused for its credential therefore reaches this
         * read, and the delegation lookup below, before the arm ever gates it. */
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        // No translator and no api key: the state both Codex gates refuse from, which most cases here start in.
        config: testConfig,
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }) }),
        /* Nothing to delegate to, which is the default this fixture wants: the delegation note is one of the
         * pieces composed into a Claude Code turn's instructions, so every such turn reaches this seam whether
         * or not it goes on to run. Grok's own gate reads the same method and overrides it with the same
         * answer — one seam, asked by two callers, which is why it belongs in the shared fixture. */
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        codexAgent: async function* () {},
        grokAgent: async function* () {},
        agent: async function* () {},
        acpAgent: async function* () {},
        ...overrides,
    });

const turn = (overrides?: Partial<AgentTurn>): AgentTurn => ({ prompt: "do the thing", ...overrides }) as AgentTurn;

beforeEach(() => {
    credentials.mockReset();
    credentials.mockResolvedValue({ ok: true, credentials: { oauthToken: "sk-oauth", account: "acc-1" } });
    browserServers.mockReset();
    browserServers.mockResolvedValue({ servers: {}, ports: {}, passkeys: {} });
});

// --- the gates: each refuses for an ordinary state of a sandbox, and says which one -----------------------

test("Codex with neither a translator subscription nor an api key names which of the two is missing", async () => {
    const noImage = await planTurn(servicesWith({ codexThreadExists: async () => true }), turn({ agent: "codex" }), context);
    expect(noImage).toMatchObject({ ok: false, code: "subscription-required" });
    // A sandbox with no translator at all can't be fixed by connecting anything, so it must not say "connect".
    expect((noImage as { message: string }).message).toContain("no model translator");

    const unconnected = servicesWith({
        codexThreadExists: async () => true,
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
    });
    const plan = await planTurn(unconnected, turn({ agent: "codex" }), context);
    expect(plan).toMatchObject({ ok: false, code: "subscription-required" });
    expect((plan as { message: string }).message).toContain("Connect your ChatGPT subscription");
});

test("Grok with no xAI sign-in is refused before a turn spawns", async () => {
    const services = servicesWith({ openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }) });

    const plan = await planTurn(services, turn({ agent: "grok" }), context);

    expect(plan.ok).toBe(false);
    expect((plan as { message: string }).message).toContain("No Grok account connected");
});

test("an ACP provider whose capability is gone is refused by name", async () => {
    const services = servicesWith({
        capabilities: unstubbed<Services["capabilities"]>("capabilities", {
            list: async () => [{ kind: "agent", id: "other-agent", config: { command: "other-agent" } }],
        }),
    });

    const plan = await planTurn(services, turn({ agent: "gemini-cli" }), context);

    expect(plan.ok).toBe(false);
    expect((plan as { message: string }).message).toContain(`Unknown agent provider "gemini-cli"`);
});

test("a harness refusal rides through with the credential resolver's own code", async () => {
    credentials.mockResolvedValue({ ok: false, code: "claude-reauth", message: "Your Claude sign-in expired." });

    const plan = await planTurn(servicesWith({}), turn(), context);

    expect(plan).toMatchObject({ ok: false, code: "claude-reauth", message: "Your Claude sign-in expired." });
});

// --- what a permitted turn is handed ----------------------------------------------------------------------

/* Both native arms resolve a CONCRETE model rather than letting their runtime pick, and for the same reason
 * twice over: the Codex CLI defaults to gpt-5-codex (which a subscription can reject) and OpenCode defaults to
 * a retired models.dev id xAI rejects outright. An omitted model is the common case — the client drops an
 * empty selection from the wire so the daemon resolves its own catalog default. */

test("Codex resolves the catalog default when the turn pins no model", async () => {
    const services = servicesWith({
        codexThreadExists: async () => true,
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [{ name: "sub", label: "sub" }], grok: [], kimi: [], gemini: [] }),
        }),
        codexModels: unstubbed<Services["codexModels"]>("codexModels", {
            models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
        }),
    });

    const plan = await planTurn(services, turn({ agent: "codex" }), context);

    expect(plan).toMatchObject({ ok: true, account: "codex-subscription" });
    expect((plan as { request: AgentRequest }).request.model).toBe("gpt-5.6-codex");
});

test("Codex receives the connected browser granted to its persona, and no other account", async () => {
    const writer: Persona = {
        id: "reddit-writer",
        capabilities: ["reddit-radarsuspam"],
        powers: PersonaPowersSchema.parse({}),
    };
    const reddit = { id: "reddit-radarsuspam", kind: "browser" as const, config: { platform: "reddit" } };
    const other = { id: "reddit-other", kind: "browser" as const, config: { platform: "reddit" } };
    browserServers.mockResolvedValue({
        servers: { identity: { type: "stdio", command: "/usr/bin/socat", args: ["STDIO", "UNIX-CONNECT:/tmp/identity.sock"] } },
        ports: { identity: 41_111 },
        passkeys: { identity: "/state/identity/passkeys.json" },
    });
    const services = codexServices({
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [reddit, other] }),
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [writer] }),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
    });

    const plan = await planTurn(services, turn({ agent: "codex", actsAs: "reddit-writer", conversationId: "reddit-conversation" }), context);
    const request = (plan as { request: AgentRequest }).request;

    expect(browserServers).toHaveBeenCalledWith([reddit], ROOT, true, "reddit-conversation");
    expect(request.sdkServers).toEqual({
        identity: { type: "stdio", command: "/usr/bin/socat", args: ["STDIO", "UNIX-CONNECT:/tmp/identity.sock"] },
    });
    expect(request.browserPorts).toEqual({ identity: 41_111 });
    expect(request.browserPasskeys).toEqual({ identity: "/state/identity/passkeys.json" });
});

test("Grok replaces a model its live catalog no longer offers, and keeps one it does", async () => {
    const services = servicesWith({
        openCode: unstubbed<Services["openCode"]>("openCode", {
            connected: async () => true,
            xaiModels: async () => ({
                default: "grok-4",
                models: [
                    { id: "grok-4", label: "Grok 4" },
                    { id: "grok-4-fast", label: "Grok 4 Fast" },
                ],
            }),
        }),
    });

    const retired = await planTurn(services, turn({ agent: "grok", model: "grok-code-fast-1" }), context);
    expect((retired as { request: AgentRequest }).request.model).toBe("grok-4");

    const offered = await planTurn(services, turn({ agent: "grok", model: "grok-4-fast" }), context);
    expect((offered as { request: AgentRequest }).request.model).toBe("grok-4-fast");
    // OpenCode holds one xAI auth, so every Grok turn attributes to the same account.
    expect(offered).toMatchObject({ account: "xai" });
});

test("iq search teaching reaches native Codex and OpenCode from the same shipped skill as Claude", async () => {
    const settings = unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
        get: async () => SandboxSettingsSchema.parse({ iqSearch: true }),
    });
    const agents = unstubbed<Services["agents"]>("agents", { entry: () => undefined });
    const codex = await planTurn(
        codexServices({
            config: { ...testConfig, iqPluginDir: IQ_PLUGIN_DIR, translator: { url: "http://127.0.0.1:8788", token: "local" } },
            sandboxSettings: settings,
            agents,
        }),
        turn({ agent: "codex", conversationId: "codex-iq" }),
        context,
    );
    expect((codex as { request: AgentRequest }).request.prompt).toContain("## iq workspace search");
    expect((codex as { request: AgentRequest }).request.prompt).toContain("iq def createIgnoreScope");

    const grok = await planTurn(
        servicesWith({
            config: { ...testConfig, iqPluginDir: IQ_PLUGIN_DIR },
            sandboxSettings: settings,
            agents,
            openCode: unstubbed<Services["openCode"]>("openCode", {
                connected: async () => true,
                xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4", label: "Grok 4" }] }),
            }),
        }),
        turn({ agent: "grok", conversationId: "grok-iq" }),
        context,
    );
    expect((grok as { request: AgentRequest }).request.prompt).toContain("## iq workspace search");
    expect((grok as { request: AgentRequest }).request.prompt).toContain("iq def createIgnoreScope");
});

test("iq search holdout assigns one balanced arm deterministically per conversation", () => {
    for (let index = 0; index < 20; index += 1) {
        const id = `conversation-${index}`;
        expect(conversationExperimentArm(id, 0.5)).toBe(conversationExperimentArm(id, 0.5));
    }
    const arms = new Set(Array.from({ length: 100 }, (_, index) => conversationExperimentArm(`conversation-${index}`, 0.5)));
    expect(arms).toEqual(new Set([true, false]));
});

// The harness arm is the deep one — it reaches settings, plugins, browser profiles and the workspace probe —
// so it needs the seams those touch before it can be planned at all.
const harnessServices = (overrides: Partial<Services> = {}): Services =>
    servicesWith({
        sessions: unstubbed<Services["sessions"]>("sessions", { exists: async () => true }),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
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
            config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
            cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
                accounts: async () => ({ codex: [{ name: "sub", label: "sub" }], grok: [], kimi: [], gemini: [] }),
            }),
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
const codexServices = (overrides: Partial<Services> = {}): Services =>
    servicesWith({
        codexThreadExists: async () => true,
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [{ name: "sub", label: "sub" }], grok: [], kimi: [], gemini: [] }),
        }),
        codexModels: unstubbed<Services["codexModels"]>("codexModels", {
            models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
        }),
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

// --- the JS execution backend: planned with the request, only where the runtime hosts it ------------------

test("a Claude turn carries the JS backend's plan — the turn tree, spawn beside its shell", async () => {
    const plan = await planTurn(harnessServices(), turn(), context);

    expect((plan as { request: AgentRequest }).request.jsExecution).toMatchObject({
        cwd: ROOT,
        readRoots: [ROOT, tmpdir()],
        writeRoots: [ROOT],
        allowSpawn: true,
    });
});

/* The user's own three-card sketch, as a test: code without bash is a real posture (the backend mounts, Bash
 * goes), and a card that switches code off keeps its shell — two switches, not one under two names. */
test("a card decides each backend on its own: code-only, and shell-only, both plan exactly what they say", async () => {
    const cards: Persona[] = [
        { id: "code-only", capabilities: [], powers: PersonaPowersSchema.parse({ shell: false }) },
        { id: "shell-only", capabilities: [], powers: PersonaPowersSchema.parse({ code: false }) },
    ];
    const services = harnessServices({ personas: unstubbed<Services["personas"]>("personas", { list: async () => cards }) });

    const codeOnly = (await planTurn(services, turn({ actsAs: "code-only" }), context)) as { request: AgentRequest };
    expect(codeOnly.request.jsExecution).toMatchObject({ allowSpawn: false });
    expect(codeOnly.request.disallowedTools).toContain("Bash");

    const shellOnly = (await planTurn(services, turn({ actsAs: "shell-only" }), context)) as { request: AgentRequest };
    expect(shellOnly.request.jsExecution).toBeUndefined();
    expect(shellOnly.request.disallowedTools ?? []).not.toContain("Bash");
});

test("a runtime that hosts no js backend is handed no plan for it, whatever the card says", async () => {
    const plan = await planTurn(codexServices(), turn({ agent: "codex" }), context);

    expect((plan as { request: AgentRequest }).request.jsExecution).toBeUndefined();
});

// Codex forwards reasoning effort (modelReasoningEffort); OpenCode takes a model id and a prompt and nothing
// else, so an effort riding a Grok request is a value nobody reads.
test("effort reaches the runtimes that forward it and no others", async () => {
    const codex = await planTurn(codexServices(), turn({ agent: "codex" }), asking({ effort: "high" }));
    expect((codex as { request: AgentRequest }).request.effort).toBe("high");

    const grokServices = servicesWith({
        openCode: unstubbed<Services["openCode"]>("openCode", {
            connected: async () => true,
            xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4", label: "Grok 4" }] }),
        }),
    });
    const grok = await planTurn(grokServices, turn({ agent: "grok" }), asking({ effort: "high" }));
    expect((grok as { request: AgentRequest }).request.effort).toBeUndefined();
});

/* FAST SPEED PASSES TWO GATES, and the second one is the whole reason this test exists.
 *
 * The first is the runtime's declared record, like every other control here. The second is the ROUTE: a
 * codex/grok/endpoint turn on the claude-code harness reads the FULL Claude Code record — same loop, same
 * ceiling, `fastMode: true` — and is then pointed at the sandbox's translator, which the harness refuses fast
 * mode for because it is not Anthropic's own endpoint. A capability check alone therefore says yes to a turn
 * that cannot possibly go fast, and the user would be left reading `not_first_party` on a control the composer
 * offered them. */
test("fast speed reaches a native Claude turn", async () => {
    const plan = await planTurn(harnessServices(), turn(), asking({ fast: true }));

    expect((plan as { request: AgentRequest }).request.fast).toBe(true);
});

test("fast speed is withheld from a routed turn, whose endpoint the harness would refuse", async () => {
    // What makes a turn routed is the credential resolver handing back an endpoint instead of an OAuth token —
    // the same shape a codex/grok/kimi/gemini turn on this harness gets in production.
    credentials.mockResolvedValue({
        ok: true,
        credentials: { endpoint: { baseUrl: "http://127.0.0.1:8788", authToken: "local", model: "gpt-5.6-codex" }, account: "sub" },
    });
    const routed = await planTurn(harnessServices(), turn({ agent: "codex", harness: "claude-code" }), asking({ fast: true }));
    const request = (routed as { request: AgentRequest }).request;

    // The turn really did take the harness arm and really is routed — otherwise this asserts nothing.
    expect(request.baseUrl).toBe("http://127.0.0.1:8788");
    expect(request.fast).toBeUndefined();
});

test("the free-trial credential's bounded policy reaches the harness request", async () => {
    credentials.mockResolvedValue({
        ok: true,
        credentials: {
            endpoint: { baseUrl: "http://127.0.0.1:8788", authToken: "local", model: "free-trial/gemini-flash-latest" },
            trial: true,
        },
    });

    const plan = await planTurn(harnessServices(), turn({ agent: "endpoint/free-trial", harness: "claude-code" }), context);

    expect((plan as { request: AgentRequest }).request.trial).toBe(true);
});

test("fast speed is withheld from every runtime that isn't the Claude Code loop", async () => {
    const codex = await planTurn(codexServices(), turn({ agent: "codex" }), asking({ fast: true }));
    expect((codex as { request: AgentRequest }).request.fast).toBeUndefined();
});

/* A runtime that can't enter the turn's mount namespace is cwd'd into its worktree and nothing more, so an
 * absolute /work path from a memory or an AGENTS.md reaches the SHARED checkout. The note is the only layer
 * left that can keep it inside its own branch — see turn-preamble.ts on why it is second-best. */
test("a cwd-isolated runtime is told where its worktree is; a namespaced one needs no telling", async () => {
    const isolated: TurnContext = { ...context, localCwd: `${HISTORY_ROOT}/worktrees/abc/work`, effectiveCwd: `${HISTORY_ROOT}/worktrees/abc/work` };
    // OpenCode is its own loop with no spawn seam of ours, so it stays on the cwd side of the axis. Codex is on
    // the namespace side with the Claude Code loop: its app-server is a child process nsenter can place.
    const grokServices = servicesWith({
        openCode: unstubbed<Services["openCode"]>("openCode", {
            connected: async () => true,
            xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4", label: "Grok 4" }] }),
        }),
    });

    const grok = await planTurn(grokServices, turn({ agent: "grok" }), isolated);
    const prompt = (grok as { request: AgentRequest }).request.prompt;
    expect(prompt).toContain("/history/worktrees/abc/work");
    expect(prompt).toContain("do the thing");

    for (const namespaced of [
        await planTurn(harnessServices(), turn(), isolated),
        await planTurn(codexServices(), turn({ agent: "codex" }), isolated),
    ]) {
        expect((namespaced as { request: AgentRequest }).request.prompt).not.toContain("Where this turn's files live");
    }
});

test("a main-tree turn has no worktree to name, so it says nothing", async () => {
    const plan = await planTurn(codexServices(), turn({ agent: "codex" }), context);

    expect((plan as { request: AgentRequest }).request.prompt).toBe("do the thing");
});

/* The pre-turn rebase is SILENT to the model — it moved the tree, and telling the agent so only ever bought a
 * verification sweep it then reported as green (turn-preamble.ts). The human still sees it in the transcript's
 * worktree frame; this is what keeps it out of the words any of the four runtimes read. */
test("a rebased branch says nothing to any runtime", async () => {
    const isolated: TurnContext = {
        ...context,
        localCwd: `${HISTORY_ROOT}/worktrees/abc/work`,
        effectiveCwd: `${HISTORY_ROOT}/worktrees/abc/work`,
    };

    for (const plan of [await planTurn(harnessServices(), turn(), isolated), await planTurn(codexServices(), turn({ agent: "codex" }), isolated)]) {
        expect((plan as { request: AgentRequest }).request.prompt).not.toContain("rebased");
    }
});

// --- the turn's standing instructions, on every runtime that will take them --------------------------------

/* THE SETTING WAS A CLAUDE CODE SETTING WEARING A SANDBOX SETTING'S NAME. The composer offers Codex, Grok and
 * Gemini on their own runtimes, and a turn on any of them ran without the owner's system prompt — and without
 * the persona note, which says which accounts a session may speak through — while nothing on screen said so.
 * The failure is silent by construction: a dropped prompt errors nowhere.
 *
 * So the assertions here are about WHICH FIELD each runtime gets, per its declared answer (capabilitiesOf's
 * `instructions`), rather than about the words: the composition itself is system-prompt.test.ts's subject. */
const customSettings = (): SandboxSettings => SandboxSettingsSchema.parse({ systemPromptMode: "custom", systemPrompt: "You write release notes." });

const withSettings = (services: Services, settings: SandboxSettings): Services => ({
    ...services,
    sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => settings }),
});

test("a runtime that replaces is handed the owner's prompt; one that only adds is handed it to add", async () => {
    const claude = await planTurn(withSettings(harnessServices(), customSettings()), turn(), context);
    expect((claude as { request: AgentRequest }).request.systemPrompt).toBe("You write release notes.");

    // Native Codex takes a replacement too, through its own config keys (codex-instructions.ts).
    const codex = await planTurn(withSettings(codexServices(), customSettings()), turn({ agent: "codex" }), context);
    expect((codex as { request: AgentRequest }).request.systemPrompt).toBe("You write release notes.");

    /* OpenCode has no seam for replacing its own base, so the owner's text arrives as an addition — which the
     * settings page says out loud rather than promising a replacement two providers cannot perform. */
    const grokServices = servicesWith({
        openCode: unstubbed<Services["openCode"]>("openCode", {
            connected: async () => true,
            xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4", label: "Grok 4" }] }),
        }),
    });
    const grok = await planTurn(withSettings(grokServices, customSettings()), turn({ agent: "grok" }), context);
    expect((grok as { request: AgentRequest }).request.systemPrompt).toBeUndefined();
    expect((grok as { request: AgentRequest }).request.systemAppend).toBe("You write release notes.");
});

/* THE WORKSPACE CONVENTIONS TRAVEL TO THE RUNTIMES THAT HAVE NO OTHER WAY TO HEAR THEM. `refs/` and `public/`
 * are facts about the filesystem — one is excluded from every scanner, the other is served on the open
 * internet — so a Codex turn that has never been told is one that will eventually commit a clone or publish a
 * log. The Claude Code loop composes them itself (sdkSystemPrompt), which is why it must NOT get them twice. */
test("a native runtime is told the workspace conventions; the Claude Code loop is not told twice", async () => {
    const codex = await planTurn(codexServices(), turn({ agent: "codex" }), context);
    expect((codex as { request: AgentRequest }).request.systemAppend).toContain("`refs/`");

    const claude = await planTurn(harnessServices(), turn(), context);
    expect((claude as { request: AgentRequest }).request.systemAppend).toBeUndefined();
});

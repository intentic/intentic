import { type AgentTurn, DEFAULT_SAFETY_POLICY, type RoutedAgentTurn, SandboxSettingsSchema, withRuntimeDefaults } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { createCredentialGrants } from "../../../secrets/credential-grants.js";
import { claudeStoreOf } from "../../../sessions/session-store.js";
import type { Services } from "../../../composition.js";
import type { MemoryReading } from "@intentic/constants/memory-room";
import { createResourceBudget, type ResourceBudget } from "../../../workload/resource-budget.js";
import { RUNTIME_ADAPTERS } from "../../../runtimes/runtime-table.js";
import { testConfig, memoryFleet, testTurnMounts } from "../../../testing.js";
import type { AgentRequest, TurnBase } from "../../providers/agent-request.js";
import { composeWirePrompt } from "../../prompt/turn-preamble.js";
import type { TurnContext } from "../../providers/adapter.js";
import { parkedCards } from "../../../conversations/actor/parked-cards.js";

// Shared fixture both turn-plan suites build on, as a `*.testing.ts` module (not copied) so the integration-budget
// checker can follow the import and judge each suite by what it uses. Mocks nothing here: `jest.mock` is global to
// the run, so each suite declares its own.

// Doesn't exist on disk, so the dependency probe finds nothing and no assertion depends on the host's checkout.
export const ROOT = "/nowhere/turn-plan";

// A box stated rather than measured, for the resource budget planTurn asks above everything else. The real reading is
// of live cgroup files at absolute paths, and since it counts swap a suite running on a machine that is genuinely full
// would refuse every fixture in these suites: a failure about the host rather than about the plan. Used memory is
// resident plus swapped, as the formula counts it.
export const memoryReading = (limitGib: number, residentGib: number, swapGib = 0, stallPercent = 0): MemoryReading => ({
    limitBytes: limitGib * 1024 ** 3,
    usedBytes: (residentGib + swapGib) * 1024 ** 3,
    swapBytes: swapGib * 1024 ** 3,
    stallPercent,
    oomKills: undefined,
});

export const ROOMY_READING: MemoryReading = memoryReading(16, 4);

// The daemon's own budget on a stated reading (or one the suite changes as it goes), with no timer, and held work
// looking again every few milliseconds so a wait for room costs a suite no real seconds.
export const budgetOn = (
    reading: MemoryReading | (() => MemoryReading) = ROOMY_READING,
    options: { readonly waitDeadlineMs?: number } = {},
): ResourceBudget =>
    createResourceBudget({
        read: async () => (typeof reading === "function" ? reading() : reading),
        sampleMs: 0,
        waitIntervalMs: 5,
        waitDeadlineMs: options.waitDeadlineMs ?? 200,
    });

export const base: TurnBase = {
    spec: { prompt: "do the thing", cwd: ROOT },
    policy: {},
    tools: {},
    // Parked with one fleet's actors, which nothing here answers.
    hooks: { cards: parkedCards(memoryFleet().conversations) },
    signal: new AbortController().signal,
};
export const context: TurnContext = {
    base,
    attachmentPaths: [],
    localCwd: ROOT,
    effectiveCwd: ROOT,
    cliEnv: {},
    steering: undefined,
};

// Only the seams a given arm actually reaches for matter; each test overrides just those. An unnamed seam answers with
// its own name (via `unstubbed`), never a bare undefined.
export const servicesWith = (overrides: Partial<Services> = {}): Services =>
    unstubbed<Services>("services", {
        tools: [],
        // The real table: which arm a (provider, harness) pair reaches is what these suites are about.
        adapters: RUNTIME_ADAPTERS,
        resources: budgetOn(),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: ROOT }),
        processes: unstubbed<Services["processes"]>("processes", { running: () => false }),
        dependencies: unstubbed<Services["dependencies"]>("dependencies", { status: async () => [], issueAt: async () => undefined }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        // Nothing gated by default; read on every turn regardless, since planTurn narrows the manifest once for every
        // runtime.
        credentialGates: unstubbed<Services["credentialGates"]>("credentialGates", { list: async () => [] }),
        credentialGrants: createCredentialGrants(),
        // Read on every turn, not just a pinned one: an unattended wake naming no persona must still answer "no
        // accounts".
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [] }),
        // No areas: the unfenced workspace, which is what a turn started by an owner carries.
        areas: unstubbed<Services["areas"]>("areas", { list: async () => [] }),
        // Where this turn's checklist is read back from; the shared store, matching the unfenced `areas` above.
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
            sessionStore: (entry) => claudeStoreOf(ROOT, testConfig.historyRoot, entry),
        }),
        // A measurement seam, not a behavioural one: runs the work, times nothing.
        perf: unstubbed<Services["perf"]>("perf", { track: (_op, _fields, run) => run() }),
        // The main line's verdicts, read for the checks-after-landing note on every turn that owes one: nothing checked
        // yet, which is what a fresh workspace reads.
        verifyStore: unstubbed<Services["verifyStore"]>("verifyStore", { read: async () => ({ projects: {}, runs: [] }) }),
        // Pre-turn retrieval asks this on every turn whose prompt carries search intent. Answers "nothing found", so a
        // plan test sees the same notes it did before the lookup existed; the retrieval's own behaviour is pinned in
        // turn-context.integration.test.ts against a real index.
        iq: unstubbed<Services["iq"]>("iq", { run: async () => ({ exitCode: 1, text: "", result: unstubbed("iq.result", {}) }) }),
        // Retrieval names every refusal at debug; a plan test asserting notes has no opinion about the log line.
        logger: unstubbed<Services["logger"]>("logger", { debug: () => {}, warn: () => {} }),
        // Schema defaults, what an unconfigured workspace reads; settings compose above the provider split, so even a
        // soon-to-refuse turn reaches this first.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        // Read once per turn, above the provider split like settings; the shipped default, what an ungoverned workspace
        // reads.
        safetyPolicy: unstubbed<Services["safetyPolicy"]>("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
        // No device connected, which is what the daemon answers with no host card granted; every planned turn asks,
        // so it belongs in the shared fixture rather than in each arm.
        hostReach: async () => undefined,
        // Same for the owner's own browsers: none connected, which every planned turn asks about too.
        webextReach: async () => undefined,
        // Leased by every planned turn: its browsers, peers and extension cards mount here.
        ...testTurnMounts(),
        // No translator and no api key: the state both Codex gates refuse from, where most cases here start.
        config: testConfig,
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }) }),
        // Nothing to delegate to by default; Grok's own gate reads this same seam, so it belongs in the shared fixture
        // rather than duplicated.
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        async *codexAgent() {},
        async *grokAgent() {},
        async *agent() {},
        async *acpAgent() {},
        ...overrides,
    });

// Routed as the port routes every turn it takes in: provider and loop named, the wire's defaults where none is given.
export const turn = (overrides?: Partial<AgentTurn>): RoutedAgentTurn => withRuntimeDefaults({ prompt: "do the thing", ...overrides } as AgentTurn);

// What the model actually reads: the plan's notes serialized in front of the prompt (composeWirePrompt), so assertions
// about "what the turn is told" stay meaningful.
export const wire = (plan: unknown): string => {
    const request = (plan as { request: AgentRequest }).request;
    return composeWirePrompt(request.spec.notes ?? [], request.spec.prompt);
};

// The harness arm is the deep one, reaching settings, plugins, browser profiles and the workspace probe, so it needs
// the seams those touch to be planned at all.
export const harnessServices = (overrides: Partial<Services> = {}): Services =>
    servicesWith({
        sessions: unstubbed<Services["sessions"]>("sessions", { exists: async () => true }),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        codexHome: "/root/.codex",
        authRoot: "/root/.local/share",
        ...overrides,
    });

// Every permission mode is offered to every provider, since there's nothing to filter before an adapter runs; the
// request must never carry a posture the adapter then silently drops. A `plan` runtime keeps plan and nothing else.
export const codexServices = (overrides: Partial<Services> = {}): Services =>
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

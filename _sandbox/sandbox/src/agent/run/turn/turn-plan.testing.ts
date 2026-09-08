import { type AgentTurn, DEFAULT_SAFETY_POLICY, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { createCredentialGrants } from "../../../secrets/credential-grants.js";
import type { Services } from "../../../composition.js";
import { testConfig } from "../../../testing.js";
import type { AgentRequest } from "../agent.js";
import { composeWirePrompt } from "../../prompt/turn-preamble.js";
import type { TurnContext } from "./turn-plan.js";

// Shared fixture both turn-plan suites build on, as a `*.testing.ts` module (not copied) so the integration-budget
// checker can follow the import and judge each suite by what it uses. Mocks nothing here: `vi.mock` hoists per module,
// so each suite keeps its own.

// Doesn't exist on disk, so the dependency probe finds nothing and no assertion depends on the host's checkout.
export const ROOT = "/nowhere/turn-plan";

export const base: AgentRequest = { prompt: "do the thing", cwd: ROOT, signal: new AbortController().signal };
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
        // A measurement seam, not a behavioural one: runs the work, times nothing.
        perf: unstubbed<Services["perf"]>("perf", { track: (_op, _fields, run) => run() }),
        // Schema defaults, what an unconfigured workspace reads; settings compose above the provider split, so even a
        // soon-to-refuse turn reaches this first.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        // Read once per turn, above the provider split like settings; the shipped default, what an ungoverned workspace
        // reads.
        safetyPolicy: unstubbed<Services["safetyPolicy"]>("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
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

export const turn = (overrides?: Partial<AgentTurn>): AgentTurn => ({ prompt: "do the thing", ...overrides }) as AgentTurn;

// What the model actually reads: the plan's notes serialized in front of the prompt (composeWirePrompt), so assertions
// about "what the turn is told" stay meaningful.
export const wire = (plan: unknown): string => {
    const request = (plan as { request: AgentRequest }).request;
    return composeWirePrompt(request.notes ?? [], request.prompt);
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

import { type AgentTurn, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { testConfig } from "../testing.js";
import type { AgentRequest } from "./agent.js";
import { composeWirePrompt } from "./turn-preamble.js";
import type { TurnContext } from "./turn-plan.js";

/* THE SEAMS A PLANNED TURN REACHES, as one fixture both turn-plan suites build on.
 *
 * It was the unit suite's alone, which is why the one case that needs a REAL tree (a skill catalogue is a
 * SKILL.md on disk or it is nothing) sat there rather than beside the other cases that build one. A test file
 * that opens a temp tree is held to the integration budget by name (_tools/checks/test-programs.mjs), so one such
 * case put the whole 600-line unit suite under it, and the suite's own header had already written down the rule
 * it was breaking: "asserted where a real tree can be built: turn-plan.integration.test.ts".
 *
 * A `*.testing.ts` module rather than a copy in each file, because the test-programs check reads that name as a fixture and
 * follows the import: each suite is then judged on the helpers IT uses, so this stays honest as the fixture
 * grows. Nothing here mocks anything: `vi.mock` hoists per module, so the two suites keep their own, which is
 * also what lets them disagree about how much of the machine to stand up.
 */

/* A workspace root that is not on disk, which is the whole point of it: planTurn probes the tree for
 * uninstalled dependencies before it dispatches (see honoured), and a root that exists would make every prompt
 * assertion depend on whatever happens to be checked out on the machine running the suite. A root with
 * nothing in it discovers no projects and therefore earns no notice. */
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

// Only the seams a given arm actually reaches for matter; each test overrides what its own gate reads, and
// every seam it doesn't name answers with its own name rather than `undefined`.
export const servicesWith = (overrides: Partial<Services> = {}): Services =>
    unstubbed<Services>("services", {
        tools: [],
        workspace: unstubbed<Services["workspace"]>("workspace", { root: ROOT }),
        processes: unstubbed<Services["processes"]>("processes", { running: () => false }),
        dependencies: unstubbed<Services["dependencies"]>("dependencies", { status: async () => [], issueAt: async () => undefined }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        // Read on every turn, not only a pinned one: an unattended wake that named no persona is exactly the
        // case whose answer must be "no accounts", so the read cannot be conditional on there being one.
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [] }),
        // A measurement seam, not a behavioural one: the planning steps file their own spans so a slow turn
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
         * answer: one seam, asked by two callers, which is why it belongs in the shared fixture. */
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        async *codexAgent() {},
        async *grokAgent() {},
        async *agent() {},
        async *acpAgent() {},
        ...overrides,
    });

export const turn = (overrides?: Partial<AgentTurn>): AgentTurn => ({ prompt: "do the thing", ...overrides }) as AgentTurn;

// What the model will actually read: the plan's typed notes serialized in front of its prompt, by the same
// function dispatch uses (agent.routes.ts). Assertions about "what the turn is told" go through this, so they
// keep meaning the wire and not whichever half of the pair they happened to grab.
export const wire = (plan: unknown): string => {
    const request = (plan as { request: AgentRequest }).request;
    return composeWirePrompt(request.notes ?? [], request.prompt);
};

// The harness arm is the deep one: it reaches settings, plugins, browser profiles and the workspace probe:
// so it needs the seams those touch before it can be planned at all.
export const harnessServices = (overrides: Partial<Services> = {}): Services =>
    servicesWith({
        sessions: unstubbed<Services["sessions"]>("sessions", { exists: async () => true }),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        codexHome: "/root/.codex",
        authRoot: "/root/.local/share",
        ...overrides,
    });

/* The composer offers every permission mode to every provider, because until an adapter is running there is
 * nothing to ask. What must NOT happen is the request carrying a posture the adapter then drops on the floor:
 * that is how "Ask before each file edit" came to sit above a runtime whose every tool call is pre-approved,
 * and how the turn journal came to record it. A `plan` runtime keeps plan and nothing else. */
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

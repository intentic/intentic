import { tmpdir } from "node:os";
import { HISTORY_ROOT } from "@intentic/constants";
import { type Persona, type SandboxSettings, PersonaPowersSchema, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../../../composition.js";
import { unstubbed } from "@intentic/testing";
import { testConfig } from "../../../testing.js";
import { UNATTENDED_ACCOUNTS_TITLE } from "../../../personas/personas.js";
import { TURN_ENDING_NOTE_HEADER } from "../../../rules/turn-ending-note.js";
import type { AgentRequest } from "../agent.js";
import { conversationExperimentArm, planTurn, ruleCommandIn, type TurnContext } from "./turn-plan.js";
import { base, codexServices, context, harnessServices, ROOT, servicesWith, turn, wire } from "./turn-plan.testing.js";

// What a turn is allowed to run on, and what it's handed once it may; session-resume rules live with the route instead
// (app.integration.test.ts). A refusal is a value (`ok: false` + code), assertable without a stream.

const credentials = vi.fn<() => Promise<Record<string, unknown>>>();
// Only the resolution is faked. The rest of the module stands, because the pre-dispatch context check reads its
// model-resolution rule (routedModel) and a mock that replaced the whole module left that undefined.
vi.mock("../../providers/harness-credentials.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../providers/harness-credentials.js")>()),
    resolveHarnessCredentials: () => credentials(),
}));
const browserServers = vi.fn();
vi.mock("../../../browser/tools/browser-tools.js", () => ({
    ROUTED_BROWSER_SERVER: "browser",
    browserServersOf: (...args: unknown[]) => browserServers(...args),
}));

/* NOTHING HERE TOUCHES THE DISK, which is what keeps this suite under the unit budget: the shared fixture's
 * ROOT is a path that does not exist, so planTurn's dependency probe discovers no projects and earns no notice,
 * and no prompt assertion below depends on whatever happens to be checked out on the machine running it. The
 * cases that need a REAL tree (a dependency notice, a skill catalogue read off disk) are asserted where one can
 * be built: turn-plan.integration.test.ts. The seams themselves live in turn-plan.testing.ts, shared with it. */
const IQ_PLUGIN_DIR = new URL("../../../../../../_search/iq/plugin", import.meta.url).pathname;

beforeEach(() => {
    credentials.mockReset();
    credentials.mockResolvedValue({ ok: true, credentials: { oauthToken: "sk-oauth", account: "acc-1" } });
    browserServers.mockReset();
    browserServers.mockResolvedValue({ servers: {}, accounts: {}, ports: {}, passkeys: {} });
});

// the gates: each refuses for an ordinary state of a sandbox, and says which one

test("Codex with neither a translator subscription nor an api key names which of the two is missing", async () => {
    const noImage = await planTurn(servicesWith({ codexThreadExists: async () => true }), turn({ agent: "codex" }), context);
    expect(noImage).toMatchObject({ ok: false, code: "subscription-required" });
    // A sandbox with no translator at all can't be fixed by connecting anything, so it must not say "connect".
    expect((noImage as { message: string }).message).toMatch(/translator/i);

    const unconnected = servicesWith({
        codexThreadExists: async () => true,
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
    });
    const plan = await planTurn(unconnected, turn({ agent: "codex" }), context);
    expect(plan).toMatchObject({ ok: false, code: "subscription-required" });
    expect((plan as { message: string }).message).toMatch(/ChatGPT|subscription/i);
});

test("Grok with no xAI sign-in is refused before a turn spawns", async () => {
    const services = servicesWith({ openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }) });

    const plan = await planTurn(services, turn({ agent: "grok" }), context);

    expect(plan.ok).toBe(false);
    expect((plan as { message: string }).message).toMatch(/Grok/i);
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

// Refused by the context check (context-budget.ts), the one gate that reads the composed prompt rather than what's
// connected; the credential resolver is mocked to succeed here.
test("a local model whose served window cannot hold the loop is refused before anything is sent", async () => {
    const tiny = {
        id: "tiny",
        kind: "localmodel" as const,
        config: { model: "meta-llama/x/Llama-3.2-3B-Instruct-Q4_K_M.gguf", gpu: "off" as const, context: "32768" as const },
    };
    const services = servicesWith({
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [tiny], get: async () => tiny }),
        endpointModels: {
            models: async () => ({ models: [{ id: "llama-3.2-3b", label: "Llama 3.2 3B", contextWindow: 16_384 }], default: "llama-3.2-3b" }),
            forget: async () => {},
        },
    });

    const plan = await planTurn(services, turn({ agent: "endpoint/tiny", model: "llama-3.2-3b" }), context);

    expect(plan).toMatchObject({ ok: false, code: "context-window-too-small" });
    expect((plan as { message: string }).message).toContain("16,384 tokens");
});

test("the same endpoint serving a large window is planned normally", async () => {
    const big = { id: "gpu-box", kind: "endpoint" as const, config: { baseUrl: "http://gpu.local:8000/v1", protocol: "openai" as const } };
    const services = servicesWith({
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [big], get: async () => big }),
        endpointModels: {
            models: async () => ({ models: [{ id: "qwen3-coder", label: "Qwen3 Coder", contextWindow: 131_072 }], default: "qwen3-coder" }),
            forget: async () => {},
        },
    });

    const plan = await planTurn(services, turn({ agent: "endpoint/gpu-box", model: "qwen3-coder" }), context);

    expect(plan.ok).toBe(true);
});

test("a harness refusal rides through with the credential resolver's own code", async () => {
    const message = "Your Claude sign-in expired.";
    credentials.mockResolvedValue({ ok: false, code: "claude-reauth", message });

    const plan = await planTurn(servicesWith({}), turn(), context);

    expect(plan).toMatchObject({ ok: false, code: "claude-reauth", message });
});

// what a permitted turn is handed

// Both native arms resolve a concrete model rather than trusting their runtime's default: Codex's own default can be
// rejected by a subscription, OpenCode's is a retired model id xAI rejects outright.

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

// A turn nobody started acts as no one, so it reaches none of the sandbox's signed-in accounts. Denying the skills is
// half the answer: the skill files stay on disk still naming the account, and the one diagnostic the sandbox points at
// a withheld credential speaks only for approver gates, so an unexplained denial reads as a broken login and sends the
// turn looking for a way around it.
test("an unattended turn is told which signed-in accounts it cannot reach", async () => {
    const npmjs = { id: "npmjs", kind: "browser" as const, config: { platform: "npmjs" } };
    const services = harnessServices({
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [npmjs] }),
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [] }),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
    });

    const plan = await planTurn(services, turn({ unattended: true, conversationId: "ci-fix-intentic-1" }), context);

    const request = (plan as { request: AgentRequest }).request;
    expect(request.disallowedTools).toContain("Skill(npmjs)");
    // Asserted through the wire prompt, since a note the composer drops is a note the model never reads. The title
    // rides the chat row rather than the prompt, so the text is what has to carry the account's name.
    expect(request.notes?.map((note: { title: string }) => note.title)).toContain(UNATTENDED_ACCOUNTS_TITLE);
    expect(wire(plan)).toContain("signed-in accounts are not loaded into it: `npmjs`");
    expect(wire(plan)).toContain("not a broken login");
});

test("a turn somebody started keeps the account, and is told nothing about a fence it is not behind", async () => {
    const npmjs = { id: "npmjs", kind: "browser" as const, config: { platform: "npmjs" } };
    const services = harnessServices({
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [npmjs] }),
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [] }),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
    });

    const plan = await planTurn(services, turn({ conversationId: "chat-1" }), context);

    const request = (plan as { request: AgentRequest }).request;
    expect(request.disallowedTools ?? []).not.toContain("Skill(npmjs)");
    // The text, not the title: titles ride the chat row and never reach the wire, so asserting one absent would pass
    // whether the note was there or not.
    expect(request.notes?.map((note: { title: string }) => note.title) ?? []).not.toContain(UNATTENDED_ACCOUNTS_TITLE);
    expect(wire(plan)).not.toContain("signed-in accounts are not loaded into it");
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

test("iq search teaching reaches native Codex and OpenCode as the shipped nudge, not the full skill Claude loads", async () => {
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
    expect(wire(codex)).toContain("## iq workspace search");
    expect(wire(codex)).toContain(".agents/skills/iq/SKILL.md");
    expect(wire(codex)).not.toContain("iq def createIgnoreScope");

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
    expect(wire(grok)).toContain("## iq workspace search");
    expect(wire(grok)).toContain(".agents/skills/iq/SKILL.md");
    expect(wire(grok)).not.toContain("iq def createIgnoreScope");
});

// The turn-ending note only needs to be said once per conversation: by the second turn it is already in the session's
// own history. Compaction erases that history, so it is the one event that re-earns the note.
const CHECKED_SETTINGS = unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
    get: async () =>
        SandboxSettingsSchema.parse({
            rules: [
                { id: "pre-land", label: "Verify before you finish", moment: "turn.ending", action: { kind: "command", command: "pnpm verify" } },
            ],
        }),
});
// A conversation as the registry has it: turns run, and the turn a compaction happened under (compactedTurn).
const conversationAt = (fields: { readonly turns: number; readonly compactedTurn?: number }): Services["agents"] =>
    unstubbed<Services["agents"]>("agents", { entry: () => fields as ReturnType<Services["agents"]["entry"]> });

test("the automatic checks are named on a conversation's opening message", async () => {
    const plan = await planTurn(harnessServices({ sandboxSettings: CHECKED_SETTINGS }), turn(), context);

    expect(wire(plan)).toContain(TURN_ENDING_NOTE_HEADER);
    expect(wire(plan)).toContain("pnpm verify");
});

test("a follow-up is not charged for them again: the note stands in the session's own history", async () => {
    const services = harnessServices({ sandboxSettings: CHECKED_SETTINGS, agents: conversationAt({ turns: 3 }) });

    const plan = await planTurn(services, turn({ conversationId: "conv-1" }), context);

    // Nothing in front of the user's words: a turn already told everything costs nothing extra.
    expect(wire(plan)).toBe("do the thing");
});

test("a turn whose conversation was just compacted is told again: its history no longer holds the note", async () => {
    const services = harnessServices({ sandboxSettings: CHECKED_SETTINGS, agents: conversationAt({ turns: 4, compactedTurn: 3 }) });

    const plan = await planTurn(services, turn({ conversationId: "conv-2" }), context);

    expect(wire(plan)).toContain(TURN_ENDING_NOTE_HEADER);
});

test("a compaction three turns back does not earn the note on every turn since", async () => {
    const services = harnessServices({ sandboxSettings: CHECKED_SETTINGS, agents: conversationAt({ turns: 6, compactedTurn: 3 }) });

    const plan = await planTurn(services, turn({ conversationId: "conv-3" }), context);

    expect(wire(plan)).not.toContain(TURN_ENDING_NOTE_HEADER);
});

test("a holdout assigns one balanced arm deterministically per conversation", () => {
    for (let index = 0; index < 20; index += 1) {
        const id = `conversation-${index}`;
        expect(conversationExperimentArm("iq-search", id, 0.5)).toBe(conversationExperimentArm("iq-search", id, 0.5));
    }
    const arms = new Set(Array.from({ length: 100 }, (_, index) => conversationExperimentArm("iq-search", `conversation-${index}`, 0.5)));
    expect(arms).toEqual(new Set([true, false]));
});

// With the experiment name baked into the hash, two experiments running at once draw independent buckets per
// conversation instead of always agreeing.
test("two experiments draw independent arms for the same conversation", () => {
    const together = Array.from({ length: 200 }, (_, index) => {
        const id = `conversation-${index}`;
        return conversationExperimentArm("iq-search", id, 0.5) === conversationExperimentArm("workspace-map", id, 0.5);
    }).filter(Boolean).length;
    // Independent draws agree about half the time. Perfect agreement is the bug this guards.
    expect(together).toBeGreaterThan(60);
    expect(together).toBeLessThan(140);
});

test("the account the credential resolver answered with becomes the turn's attribution key", async () => {
    const plan = await planTurn(harnessServices(), turn(), context);

    expect(plan).toMatchObject({ ok: true, account: "acc-1" });
});

// what the runtime's declared record takes off the request

// The route already folds the turn's posture into the request before an arm is picked, so this edits context, not the
// turn.
const asking = (overrides: Partial<AgentRequest>): TurnContext => ({ ...context, base: { ...base, ...overrides } });

test("a plan-only runtime keeps `plan` and is handed no other permission mode", async () => {
    const asked = await planTurn(codexServices(), turn({ agent: "codex" }), asking({ permissionMode: "acceptEdits" }));
    expect((asked as { request: AgentRequest }).request.permissionMode).toBeUndefined();

    const planning = await planTurn(codexServices(), turn({ agent: "codex" }), asking({ permissionMode: "plan" }));
    expect((planning as { request: AgentRequest }).request.permissionMode).toBe("plan");
});

test("the Claude Code loop keeps every mode: it is the runtime that honours them", async () => {
    const plan = await planTurn(harnessServices(), turn(), asking({ permissionMode: "acceptEdits" }));

    expect((plan as { request: AgentRequest }).request.permissionMode).toBe("acceptEdits");
});

// the JS execution backend: planned with the request, only where the runtime hosts it

test("a Claude turn carries the JS backend's plan, the turn tree, spawn beside its shell", async () => {
    const plan = await planTurn(harnessServices(), turn(), context);

    expect((plan as { request: AgentRequest }).request.jsExecution).toMatchObject({
        cwd: ROOT,
        readRoots: [ROOT, tmpdir()],
        writeRoots: [ROOT],
        allowSpawn: true,
    });
});

// Code-only and shell-only are independent switches, not one control under two names: turning off shell still mounts
// the JS backend, and turning off code still keeps Bash.
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

// Codex forwards reasoning effort (modelReasoningEffort); OpenCode only takes a model id and a prompt, so an effort
// riding a Grok request is read by nobody.
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

// Fast speed passes two gates: the runtime's declared capability, and the route — a codex/grok/endpoint turn riding the
// Claude Code harness inherits its record, which the harness refuses fast mode for on a non-Anthropic endpoint.
test("fast speed reaches a native Claude turn", async () => {
    const plan = await planTurn(harnessServices(), turn(), asking({ fast: true }));

    expect((plan as { request: AgentRequest }).request.fast).toBe(true);
});

test("fast speed is withheld from a routed turn, whose endpoint the harness would refuse", async () => {
    // Routed means the resolver returns an endpoint, not an OAuth token, as a codex/grok/kimi/gemini turn does in
    // production.
    credentials.mockResolvedValue({
        ok: true,
        credentials: { endpoint: { baseUrl: "http://127.0.0.1:8788", authToken: "local", model: "gpt-5.6-codex" }, account: "sub" },
    });
    const routed = await planTurn(harnessServices(), turn({ agent: "codex", harness: "claude-code" }), asking({ fast: true }));
    const request = (routed as { request: AgentRequest }).request;

    // The turn really did take the harness arm and really is routed: otherwise this asserts nothing.
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

// A runtime that can't enter the turn's mount namespace is only cwd'd into its worktree, so an absolute /work path
// would otherwise reach the shared checkout; the note keeps it inside its own branch, in full once then as compact
// reminders.
test("a cwd-isolated runtime gets one worktree explanation, then compact reminders; a namespaced one gets neither", async () => {
    const isolated: TurnContext = { ...context, localCwd: `${HISTORY_ROOT}/worktrees/abc/work`, effectiveCwd: `${HISTORY_ROOT}/worktrees/abc/work` };
    // OpenCode has no spawn seam of ours, so it stays on the cwd side; Codex runs under the Claude Code loop, whose
    // app-server is a child process nsenter can place in the namespace.
    const grokServices = servicesWith({
        openCode: unstubbed<Services["openCode"]>("openCode", {
            connected: async () => true,
            xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4", label: "Grok 4" }] }),
        }),
    });

    const grok = await planTurn(grokServices, turn({ agent: "grok" }), isolated);
    const prompt = wire(grok);
    expect(prompt).toContain("/history/worktrees/abc/work");
    expect(prompt).toContain("do the thing");

    const followup = await planTurn(grokServices, turn({ agent: "grok" }), { ...isolated, base: { ...isolated.base, sessionId: "session-1" } });
    const followupPrompt = wire(followup);
    const sharedCheckout = "/nowhere/turn-plan";
    expect(followupPrompt).toMatch(/relative paths/i);
    expect(followupPrompt).toContain(sharedCheckout);
    expect(followupPrompt).not.toContain("/history/worktrees/abc/work");

    for (const namespaced of [
        await planTurn(harnessServices(), turn(), isolated),
        await planTurn(codexServices(), turn({ agent: "codex" }), isolated),
    ]) {
        expect(wire(namespaced)).not.toContain("Where this turn's files live");
    }
});

test("a main-tree turn has no worktree to name, so it says nothing", async () => {
    const plan = await planTurn(codexServices(), turn({ agent: "codex" }), context);

    expect(wire(plan)).toBe("do the thing");
});

test("every runtime is told which automatic check runs when its turn ends", async () => {
    const gated = SandboxSettingsSchema.parse({
        rules: [
            {
                id: "pre-land",
                label: "Verify before you finish",
                moment: "turn.ending",
                action: { kind: "command", command: "cd intentic && pnpm lint && pnpm verify", timeoutMs: 900_000 },
                enabled: true,
            },
        ],
    });

    // Claude Code runs the command rules at its Stop; a native runtime gets the same rules from the daemon once its
    // frames end (agent.routes.ts daemonStopFindings), so neither is promised a check nothing runs.
    for (const plan of [
        await planTurn(withSettings(harnessServices(), gated), turn(), context),
        await planTurn(withSettings(codexServices(), gated), turn({ agent: "codex" }), context),
    ]) {
        expect(wire(plan)).toContain("**Verify before you finish:** `cd intentic && pnpm lint && pnpm verify`");
        expect(wire(plan)).toContain("Do not run or announce them yourself");
    }

    // No command rule stands, so nothing is promised.
    expect(wire(await planTurn(harnessServices(), turn(), context))).toBe("do the thing");
    expect(wire(await planTurn(codexServices(), turn({ agent: "codex" }), context))).toBe("do the thing");
});

// The pre-turn rebase says nothing to the model: telling it only bought a verification sweep reported green. The human
// still sees it in the transcript's worktree frame.
test("a rebased branch says nothing to any runtime", async () => {
    const isolated: TurnContext = {
        ...context,
        localCwd: `${HISTORY_ROOT}/worktrees/abc/work`,
        effectiveCwd: `${HISTORY_ROOT}/worktrees/abc/work`,
    };

    for (const plan of [await planTurn(harnessServices(), turn(), isolated), await planTurn(codexServices(), turn({ agent: "codex" }), isolated)]) {
        expect(wire(plan)).not.toContain("rebased");
    }
});

// the turn's standing instructions, on every runtime that will take them

// A turn on Codex, Grok or Gemini could silently run without the owner's system prompt or persona note, with nothing on
// screen saying so. Asserts which field each runtime gets, not the wording (system-prompt.test.ts's subject).
const CUSTOM_PROMPT = "You write release notes.";
const customSettings = (): SandboxSettings => SandboxSettingsSchema.parse({ systemPromptMode: "custom", systemPrompt: CUSTOM_PROMPT });

const withSettings = (services: Services, settings: SandboxSettings): Services => ({
    ...services,
    sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => settings }),
});

test("a runtime that replaces is handed the owner's prompt; one that only adds is handed it to add", async () => {
    const claude = await planTurn(withSettings(harnessServices(), customSettings()), turn(), context);
    expect((claude as { request: AgentRequest }).request.systemPrompt).toBe(CUSTOM_PROMPT);

    // Native Codex takes a replacement too, through its own config keys (codex-instructions.ts).
    const codex = await planTurn(withSettings(codexServices(), customSettings()), turn({ agent: "codex" }), context);
    expect((codex as { request: AgentRequest }).request.systemPrompt).toBe(CUSTOM_PROMPT);

    // OpenCode has no seam to replace its own base prompt, so the owner's text arrives as an addition instead, matching
    // what the settings page promises rather than a replacement it can't perform.
    const grokServices = servicesWith({
        openCode: unstubbed<Services["openCode"]>("openCode", {
            connected: async () => true,
            xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4", label: "Grok 4" }] }),
        }),
    });
    const grok = await planTurn(withSettings(grokServices, customSettings()), turn({ agent: "grok" }), context);
    expect((grok as { request: AgentRequest }).request.systemPrompt).toBeUndefined();
    expect((grok as { request: AgentRequest }).request.systemAppend).toBe(CUSTOM_PROMPT);
});

// `refs/` (excluded from scanners) and `public/` (served on the open internet) must reach a runtime with no other way
// to learn them, like Codex; the Claude Code loop composes them itself and must not be told twice.
test("a native runtime is told the workspace conventions; the Claude Code loop is not told twice", async () => {
    const codex = await planTurn(codexServices(), turn({ agent: "codex" }), context);
    expect((codex as { request: AgentRequest }).request.systemAppend).toContain("`refs/`");

    const claude = await planTurn(harnessServices(), turn(), context);
    expect((claude as { request: AgentRequest }).request.systemAppend).toBeUndefined();
});

// A rule's command must run inside the turn's namespace, not the daemon's: the daemon-side worktree has empty
// dependency directories (isolation.ts), so an unqualified command fails. `bash -c` with the whole line quoted keeps a
// shell line as nsenter's single argv.
test("a rule's command enters the turn's namespace, and only when there is one", () => {
    const anchored = ruleCommandIn(`cd intentic && pnpm lint`, { pid: 4242, cwd: `/work`, plan: {} as never, dispose: () => undefined });
    expect(anchored).toContain(`nsenter --mount=/proc/4242/ns/mnt`);
    expect(anchored).toContain(`--wdns=/work`);
    // Strips the daemon's PWD/OLDPWD so the command's relative cd resolves against nsenter's cwd, not an inherited
    // stale one.
    expect(anchored).toContain(`env -u PWD -u OLDPWD`);
    // The whole line is one argument, so the `&&` is the inner shell's rather than the outer one's.
    expect(anchored).toMatch(/bash -c '.*pnpm lint.*'/u);

    // An unisolated turn already runs where it means to; wrapping it would only add a process.
    expect(ruleCommandIn(`pnpm lint`, undefined)).toBe(`pnpm lint`);
});

// Inside the namespace the directory comes from `--wdns`, not from the cwd the daemon-side process was handed, so a
// rule naming a repository has to say so this far down or it runs at the root of the worktree while every other part
// of the system agrees it is running in the repository.
test("a rule naming a repository enters the namespace inside that repository", () => {
    const anchor = { pid: 4242, cwd: `/work`, plan: {} as never, dispose: () => undefined };
    expect(ruleCommandIn(`pnpm verify:push`, anchor, `intentic`)).toContain(`--wdns=/work/intentic`);
    // "root" is the workspace's own repository, which is where an unaimed command already runs.
    expect(ruleCommandIn(`pnpm verify:push`, anchor, `root`)).toContain(`--wdns=/work`);
});

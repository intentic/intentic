import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { claudeStoreOf } from "../../../sessions/session-store.js";
import { createCredentialGrants } from "../../../secrets/credential-grants.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTurn, DEFAULT_SAFETY_POLICY, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { conversationAfter, testConfig, memoryFleet } from "../../../testing.js";
import { SKILL_CATALOG_NOTE_HEADER } from "../../../store/loaded-skills.js";
import { SETUP_NOTICE_HEADER, STALE_NOTICE_HEADER, workspaceSetup } from "../../../workspace/layout/workspace-setup.js";
import { landingChecksNote } from "../../../workspace/deps/mainline-note.js";
import type { AgentRequest } from "../../providers/agent-request.js";
import { composeWirePrompt } from "../../prompt/turn-preamble.js";
import type { TurnContext } from "../../providers/adapter.js";
import { planTurn } from "./turn-plan.js";
import { base, codexServices, context, harnessServices, ROOMY_MEMORY, servicesWith, turn, wire } from "./turn-plan.testing.js";
import { createMemoryWarnings } from "../../../platform/resources/memory-admission.js";
import { RUNTIME_ADAPTERS } from "../../../runtimes/runtime-table.js";
import { parkedCards } from "../../../agents/actor/parked-cards.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// Every runtime is told the tree is behind, but the delivery differs: a full runtime gets readiness tools and hooks,
// native runtimes (with no such seam) get the prose note instead.

// The harness arm's credential resolution, which is a question about the owner's accounts rather than about the
// tree: stubbed so the Claude case below can reach the part this file is actually asserting on. The native arms
// never call it.
jest.mock("../../providers/harness-credentials.js", () => ({
    resolveHarnessCredentials: async () => ({ ok: true, credentials: { oauthToken: "***", account: "acc-1" } }),
}));

const workspaceWithMissingDeps = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "turn-plan-"));
    // A manifest with no install: `node_modules`'s absence is the whole signal.
    await writeFile(join(root, "package.json"), `{"name":"app","dependencies":{"left-pad":"^1.0.0"}}`);
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    return root;
};

// Mimics an isolated turn's tree as the daemon sees it: dependencies are empty directories, since the real tree is an
// overlay mounted inside the turn's own namespace, not the daemon's.
const daemonSideWorktree = async (): Promise<string> => {
    const worktree = await mkdtemp(join(tmpdir(), "turn-plan-wt-"));
    await writeFile(join(worktree, "package.json"), `{"name":"app","dependencies":{"left-pad":"^1.0.0"}}`);
    await writeFile(join(worktree, "pnpm-lock.yaml"), "");
    await mkdir(join(worktree, "node_modules"), { recursive: true });
    return worktree;
};

const contextIn = (root: string, localCwd = root): TurnContext => ({
    base: { spec: { prompt: "do the thing", cwd: root }, policy: {}, tools: {}, hooks: { cards }, signal: new AbortController().signal },
    attachmentPaths: [],
    localCwd,
    effectiveCwd: localCwd,
    cliEnv: {},
    steering: undefined,
});

// A translator holding the ChatGPT subscription, which both native arms below authenticate against.
const servicesIn = (root: string, overrides: Partial<Services> = {}): Services =>
    unstubbed<Services>("services", {
        tools: [],
        // The real table: which arm a (provider, harness) pair reaches is part of what a plan is.
        adapters: RUNTIME_ADAPTERS,
        memoryHeadroom: ROOMY_MEMORY,
        memoryWarnings: createMemoryWarnings(),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        processes: unstubbed<Services["processes"]>("processes", { running: () => false }),
        dependencies: unstubbed<Services["dependencies"]>("dependencies", {
            status: () => workspaceSetup(root, unstubbed<Services["processes"]>("processes", { running: () => false })),
            issueAt: async () => undefined,
        }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        // Nothing gated: planTurn reads the approval policy on every turn whether or not a gate exists.
        credentialGates: unstubbed<Services["credentialGates"]>("credentialGates", { list: async () => [] }),
        credentialGrants: createCredentialGrants(),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        // Every turn resolves a persona now; an empty list is the open, attended posture these tests assume.
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [] }),
        // No areas: the unfenced workspace, which is what a turn an owner started carries.
        areas: unstubbed<Services["areas"]>("areas", { list: async () => [] }),
        // Where this turn's checklist is read back from; the shared store, matching the unfenced `areas` above.
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
            sessionStore: (entry) => claudeStoreOf(root, testConfig.historyRoot, entry),
        }),
        // A measurement seam, not a behavioural one: runs the work, times nothing.
        perf: unstubbed<Services["perf"]>("perf", { track: (_op, _fields, run) => run() }),
        // The main line's verdicts, read for the checks-after-landing note an opening turn is sent: nothing checked yet.
        verifyStore: unstubbed<Services["verifyStore"]>("verifyStore", { read: async () => ({ projects: {}, runs: [] }) }),
        // Snapshotted for the judge on every planned turn, so every arm below needs it too.
        safetyPolicy: unstubbed<Services["safetyPolicy"]>("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
        // No device connected in these arms, which is what the daemon answers with none granted; a turn asks on
        // every plan, so every arm needs it.
        hostReach: async () => undefined,
        webextReach: async () => undefined,
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [{ name: "sub", label: "sub" }], grok: [], kimi: [], gemini: [] }),
        }),
        async *codexAgent() {},
        async *grokAgent() {},
        ...overrides,
    });

// What the model actually reads: the plan's notes serialized in front of the prompt, via the same function dispatch
// uses (composeWirePrompt).
const promptOf = async (services: Services, agentTurn: AgentTurn, turnContext: TurnContext): Promise<string> => {
    const plan = await planTurn(services, agentTurn, turnContext);
    expect(plan).toMatchObject({ ok: true });
    const request = (plan as { request: AgentRequest }).request;
    return composeWirePrompt(request.spec.notes ?? [], request.spec.prompt);
};

// The harness arm gets the readiness mechanism now, not a paragraph re-stapled to every message in the conversation
// regardless of which turn actually needs it.
test("a Claude turn gets the readiness tools instead of the paragraph, however far behind the tree is", async () => {
    const root = await workspaceWithMissingDeps();
    const services = servicesIn(root, {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        // The delegation note asks which other coding agents this sandbox can hand off to; none, here.
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        async *codexAgent() {},
        async *agent() {},
    });

    const plan = await planTurn(services, { prompt: "do the thing" } as AgentTurn, contextIn(root));
    expect(plan).toMatchObject({ ok: true });
    const request = (plan as { request: AgentRequest }).request;

    expect(request.spec.prompt).toBe("do the thing");
    expect(Object.keys(request.tools.sdkServers ?? {})).toContain("deps");
    // And the daemon's own records, so "why did that fail" is a tool call, not a rebuild of the instrumentation.
    expect(Object.keys(request.tools.sdkServers ?? {})).toContain("diagnostics");
    // Daemon-side readers still need the real tree: the isolated turn's cwd names a worktree with empty mounts.
    expect(request.spec.sessionStore).toBe(claudeStoreOf(root, testConfig.historyRoot, undefined));
});

// A persona that can't read the workspace can't read the daemon's log either: withheld whole, since half an answer
// about a failure is worse than none.
test("a persona with no file reads does not get the diagnostic tools", async () => {
    const root = await workspaceWithMissingDeps();
    const services = servicesIn(root, {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        async *codexAgent() {},
        async *agent() {},
        personas: unstubbed<Services["personas"]>("personas", {
            list: async () => [{ id: "reader", name: "Reader", powers: { files: "none", shell: false } }] as never,
        }),
    });

    const plan = await planTurn(services, { prompt: "do the thing", actsAs: "reader" } as AgentTurn, contextIn(root));
    expect(plan).toMatchObject({ ok: true });
    expect((plan as { request: AgentRequest }).request.tools.sdkServers?.["diagnostics"]).toBeUndefined();
});

// The whole reason memory is composed here: a card that starts a conversation inside one folder used to be at the mercy
// of the runtime's own discovery, which stops at a nested repo on some loops and does not exist at all on others.
test("a persona starting in a nested folder is told the workspace's rules and that folder's", async () => {
    const root = await mkdtemp(join(tmpdir(), "turn-plan-"));
    await mkdir(join(root, "shop"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "No legacy support.");
    await writeFile(join(root, "shop/AGENTS.md"), "Prices are integers, in cents.");
    const services = servicesIn(root, {
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        async *agent() {},
        personas: unstubbed<Services["personas"]>("personas", {
            list: async () => [{ id: "shopkeeper", label: "Shopkeeper", capabilities: [], workspace: { startIn: "shop" } }] as never,
        }),
    });

    const plan = await planTurn(services, { prompt: "do the thing", actsAs: "shopkeeper" } as AgentTurn, contextIn(root));
    expect(plan).toMatchObject({ ok: true });
    const request = (plan as { request: AgentRequest }).request;

    expect(request.spec.cwd).toBe(join(root, "shop"));
    expect(request.spec.systemAppend).toContain("No legacy support.");
    expect(request.spec.systemAppend).toContain("Prices are integers, in cents.");
});

test("a native Codex turn is told the tree's dependencies are missing, exactly as a Claude turn no longer is", async () => {
    const root = await workspaceWithMissingDeps();
    const services = servicesIn(root, {
        codexThreadExists: async () => true,
        codexModels: unstubbed<Services["codexModels"]>("codexModels", {
            models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
        }),
    });

    const prompt = await promptOf(services, { prompt: "do the thing", agent: "codex" } as AgentTurn, contextIn(root));

    expect(prompt).toContain(SETUP_NOTICE_HEADER);
    expect(prompt).toMatch(/ask the owner/i);
    expect(prompt).not.toContain(": run `pnpm install`");
    // The user's own words still end the message: the notice is a preamble, not a replacement.
    expect(prompt.endsWith("do the thing")).toBe(true);
});

test("a resumed native session is not charged the same dependency paragraph on every follow-up", async () => {
    const root = await workspaceWithMissingDeps();
    const services = servicesIn(root, {
        codexThreadExists: async () => true,
        codexModels: unstubbed<Services["codexModels"]>("codexModels", {
            models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
        }),
        // A follow-up in a conversation two turns in, which its session's own history already told everything.
        agents: unstubbed<Services["agents"]>("agents", { entry: () => conversationAfter(2) }),
    });
    const resumed = contextIn(root);
    const prompt = await promptOf(services, { prompt: "do the thing", agent: "codex", conversationId: "c-resumed" } as AgentTurn, {
        ...resumed,
        base: { ...resumed.base, spec: { ...resumed.base.spec, sessionId: "codex-session-1" } },
    });

    expect(prompt).toBe("do the thing");
});

test("a native Grok turn hears it too: the note belongs to the tree, not to the runtime", async () => {
    const root = await workspaceWithMissingDeps();
    const services = servicesIn(root, {
        openCode: unstubbed<Services["openCode"]>("openCode", {
            connected: async () => true,
            xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4", label: "Grok 4" }] }),
        }),
    });

    const prompt = await promptOf(services, { prompt: "do the thing", agent: "grok" } as AgentTurn, contextIn(root));

    expect(prompt).toContain(SETUP_NOTICE_HEADER);
});

test("an installed tree earns no notice, so an opening turn is the user's message and the checks note alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "turn-plan-"));
    const services = servicesIn(root, {
        codexThreadExists: async () => true,
        codexModels: unstubbed<Services["codexModels"]>("codexModels", {
            models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
        }),
    });

    const prompt = await promptOf(services, { prompt: "do the thing", agent: "codex" } as AgentTurn, contextIn(root));

    // What runs after the work lands is every opening message's to hear; nothing about the tree's dependencies joins it.
    expect(prompt).toBe(composeWirePrompt([landingChecksNote([], false)], "do the thing"));
});

// The probe must ask about the tree the turn itself resolves through, not the daemon's worktree view: a daemon-side
// probe sees only empty mount points and misreports the whole workspace as uninstalled.
test("an isolated turn is not told its dependencies are missing just because the daemon cannot see them", async () => {
    const main = await mkdtemp(join(tmpdir(), "turn-plan-"));
    const services = servicesIn(main, {
        codexThreadExists: async () => true,
        codexModels: unstubbed<Services["codexModels"]>("codexModels", {
            models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
        }),
    });

    const prompt = await promptOf(services, { prompt: "do the thing", agent: "codex" } as AgentTurn, contextIn(main, await daemonSideWorktree()));

    // Neither fires here: the worktree read daemon-side has the marker, so at most STALE applies, never
    // never-installed.
    expect(prompt).not.toContain(STALE_NOTICE_HEADER);
    expect(prompt).not.toContain(SETUP_NOTICE_HEADER);
    // The worktree note is a different fact and still belongs: this runtime reaches its branch by cwd alone.
    expect(prompt.endsWith("do the thing")).toBe(true);
});

// Needs a real SKILL.md on disk, hence integration rather than unit. Pins the asymmetry: a runtime with no skill loader
// gets the catalogue once; native loaders that load skills themselves are never told, to avoid a duplicate list.
test("a runtime without a skill loader receives the catalogue once; native loaders are not told twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "turn-skills-"));
    const skillDir = join(root, ".agents", "skills", "quill");
    await mkdir(skillDir, { recursive: true });
    const skillDescription = "Draws quills. Use when asked for quills.";
    await writeFile(join(skillDir, "SKILL.md"), `---\nname: quill\ndescription: ${skillDescription}\n---\n\nDraw a quill.\n`);
    const skillContext: TurnContext = {
        ...context,
        base: { ...base, spec: { ...base.spec, cwd: root } },
        localCwd: root,
        effectiveCwd: root,
    };
    const workspace = unstubbed<Services["workspace"]>("workspace", { root });
    const openCode = unstubbed<Services["openCode"]>("openCode", {
        connected: async () => true,
        xaiModels: async () => ({ default: "grok-4", models: [{ id: "grok-4", label: "Grok 4" }] }),
    });

    const grok = await planTurn(servicesWith({ workspace, openCode }), turn({ agent: "grok" }), skillContext);
    expect(wire(grok)).toContain(SKILL_CATALOG_NOTE_HEADER);
    expect(wire(grok)).toContain(skillDescription);
    expect(wire(grok)).toContain(join(root, ".agents", "skills", "quill", "SKILL.md"));

    const followup = await planTurn(
        servicesWith({
            workspace,
            openCode,
            agents: unstubbed<Services["agents"]>("agents", { entry: () => conversationAfter(2) }),
        }),
        turn({ agent: "grok", conversationId: "grok-skills" }),
        skillContext,
    );
    expect(wire(followup)).not.toContain(SKILL_CATALOG_NOTE_HEADER);

    const codex = await planTurn(codexServices({ workspace }), turn({ agent: "codex" }), skillContext);
    expect(wire(codex)).not.toContain(SKILL_CATALOG_NOTE_HEADER);

    const claude = await planTurn(harnessServices({ workspace }), turn(), skillContext);
    expect(wire(claude)).not.toContain(SKILL_CATALOG_NOTE_HEADER);
});

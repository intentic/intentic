import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { claudeStoreOf } from "../../sessions/session-store.js";
import { createCredentialGrants } from "../../secrets/credential-grants.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTurn, type Persona, DEFAULT_SAFETY_POLICY, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { conversationAfter, testConfig, memoryFleet, testTurnMounts } from "../../testing.js";
import { workspaceSetup } from "../../workspace/layout/workspace-setup.js";
import { LANDING_CHECKS_NOTE_TITLE, landingChecksNote } from "../../workspace/deps/mainline-note.js";
import type { AgentRequest } from "../providers/agent-request.js";
import type { TurnContext } from "../providers/adapter.js";
import { planTurn } from "../run/turn/turn-plan.js";
import { budgetOn } from "../run/turn/turn-plan.testing.js";
import { composeWirePrompt, preambleNotes, stripTurnPreamble } from "./turn-preamble.js";
import { WORKSPACE_MAP_NOTE_HEADER } from "./workspace-map.js";
import { RUNTIME_ADAPTERS } from "../../runtimes/runtime-table.js";
import { parkedCards } from "../../agents/actor/parked-cards.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// What every opening message is told of the checks that run after its work lands, with the main tree green.
const OPENING_CHECKS_NOTE = landingChecksNote([], false);

// Pins the four turn-plan gates around the workspace map (the generator itself has its own suite): off must mean off,
// sent once per conversation, honoured on every runtime, and built against the run's actual tree, not the shared
// checkout.

jest.mock("../providers/harness-credentials.js", () => ({
    resolveHarnessCredentials: async () => ({ ok: true, credentials: { oauthToken: "***", account: "acc-1" } }),
}));

// A project with enough shape to be worth a map: three areas, one of them describing itself.
const projectAt = async (prefix: string, marker: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    await writeFile(join(root, "package.json"), `{"name":"app"}`);
    for (const [area, description] of [
        ["billing", `The ${marker} billing area`],
        ["mailer", `The ${marker} mailer area`],
        ["docs", ""],
    ] as const) {
        await mkdir(join(root, area), { recursive: true });
        await writeFile(join(root, area, "index.ts"), "");
        if (description !== "") {
            await writeFile(join(root, area, "package.json"), JSON.stringify({ name: area, description }));
        }
    }
    return root;
};

// The model's message comes from CONTEXT.base.spec.prompt, not the turn's; attachments are already folded in by then.
const contextIn = (root: string, localCwd = root, prompt = "do the thing"): TurnContext => ({
    base: { spec: { prompt, cwd: root }, policy: {}, tools: {}, hooks: { cards }, signal: new AbortController().signal },
    attachmentPaths: [],
    localCwd,
    effectiveCwd: localCwd,
    cliEnv: {},
    steering: undefined,
});

const servicesIn = (root: string, settings: Partial<Record<string, unknown>>, overrides: Partial<Services> = {}): Services =>
    unstubbed<Services>("services", {
        tools: [],
        // The real table: which arm a (provider, harness) pair reaches is part of what a plan is.
        adapters: RUNTIME_ADAPTERS,
        resources: budgetOn(),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        processes: unstubbed<Services["processes"]>("processes", { running: () => false }),
        dependencies: unstubbed<Services["dependencies"]>("dependencies", {
            status: () => workspaceSetup(root, unstubbed<Services["processes"]>("processes", { running: () => false })),
            issueAt: async () => undefined,
        }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        // Empty on purpose: planTurn reads the policy every turn whether or not a gate exists.
        credentialGates: unstubbed<Services["credentialGates"]>("credentialGates", { list: async () => [] }),
        credentialGrants: createCredentialGrants(),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse(settings),
        }),
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [] }),
        // No areas: the unfenced workspace, which is what a turn an owner started carries.
        areas: unstubbed<Services["areas"]>("areas", { list: async () => [] }),
        // Where this turn's checklist is read back from; the shared store, matching the unfenced `areas` above.
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
            sessionStore: (entry) => claudeStoreOf(root, testConfig.historyRoot, entry),
        }),
        perf: unstubbed<Services["perf"]>("perf", { track: (_op, _fields, run) => run() }),
        // The main line's verdicts, read for the checks-after-landing note an opening turn is sent: nothing checked yet.
        verifyStore: unstubbed<Services["verifyStore"]>("verifyStore", { read: async () => ({ projects: {}, runs: [] }) }),
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [{ name: "sub", label: "sub" }], grok: [], kimi: [], gemini: [] }),
        }),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        // Read once per turn and carried for the judge: every planned turn reaches it, map or no map.
        safetyPolicy: unstubbed<Services["safetyPolicy"]>("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
        // No device connected in these arms, which is what the daemon answers with none granted; a turn asks on
        // every plan, so every arm needs it.
        hostReach: async () => undefined,
        webextReach: async () => undefined,
        // Leased by every planned turn: its browsers, peers and extension cards mount here.
        ...testTurnMounts(),
        async *codexAgent() {},
        async *grokAgent() {},
        async *agent() {},
        ...overrides,
    });

// What the model actually reads: notes serialized by the same function dispatch uses (composeWirePrompt).
const promptOf = async (services: Services, turn: AgentTurn, context: TurnContext): Promise<string> => {
    const plan = await planTurn(services, turn, context);
    expect(plan).toMatchObject({ ok: true });
    const request = (plan as { request: AgentRequest }).request;
    return composeWirePrompt(request.spec.notes ?? [], request.spec.prompt);
};

test("the map rides the opening message when the setting is on, and the user's words still end it", async () => {
    const marker = "shared";
    const root = await projectAt("wsmap-on-", marker);

    const prompt = await promptOf(servicesIn(root, { workspaceMap: true }), { prompt: "do the thing" } as AgentTurn, contextIn(root));

    expect(prompt).toContain(WORKSPACE_MAP_NOTE_HEADER);
    expect(prompt).toContain(`The ${marker} billing area`);
    expect(prompt.endsWith("do the thing")).toBe(true);
});

test("an opt-in that is off adds nothing at all", async () => {
    const root = await projectAt("wsmap-off-", "shared");

    const prompt = await promptOf(servicesIn(root, {}), { prompt: "do the thing" } as AgentTurn, contextIn(root));

    // The checks note is every opening message's, map or no map; nothing of the map's own rides beside it.
    expect(prompt).toBe(composeWirePrompt([OPENING_CHECKS_NOTE], "do the thing"));
});

test("a follow-up in the same conversation is not charged for the map again", async () => {
    const root = await projectAt("wsmap-again-", "shared");
    const services = servicesIn(
        root,
        { workspaceMap: true },
        {
            // Non-zero `turns` means the conversation already carries the map in its own transcript.
            agents: unstubbed<Services["agents"]>("agents", { entry: () => conversationAfter(3) }),
        },
    );

    const prompt = await promptOf(services, { prompt: "and now this", conversationId: "conv-1" } as AgentTurn, contextIn(root, root, "and now this"));

    expect(prompt).toBe("and now this");
});

test("a native Codex turn gets the same map: it is a fact about the filesystem, not about one loop", async () => {
    const sharedMarker = "shared";
    const root = await projectAt("wsmap-codex-", sharedMarker);
    const services = servicesIn(
        root,
        { workspaceMap: true },
        {
            codexThreadExists: async () => true,
            codexModels: unstubbed<Services["codexModels"]>("codexModels", {
                models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
            }),
        },
    );

    const prompt = await promptOf(services, { prompt: "do the thing", agent: "codex" } as AgentTurn, contextIn(root));

    expect(prompt).toContain(WORKSPACE_MAP_NOTE_HEADER);
    expect(prompt).toContain(`The ${sharedMarker} billing area`);
});

// root and worktree get different area descriptions here, so a map built from the wrong tree is a mismatch the
// assertions would catch, not a coincidence.
test("an isolated turn is mapped against its own tree, not the shared checkout", async () => {
    const sharedMarker = "shared";
    const branchMarker = "branch";
    const root = await projectAt("wsmap-root-", sharedMarker);
    const worktree = await projectAt("wsmap-wt-", branchMarker);

    const prompt = await promptOf(servicesIn(root, { workspaceMap: true }), { prompt: "do the thing" } as AgentTurn, contextIn(root, worktree));

    expect(prompt).toContain(`The ${branchMarker} billing area`);
    expect(prompt).not.toContain(`The ${sharedMarker} billing area`);
});

// The fifth gate, and the only per-card one: the sandbox switch says yes and the card still says no. Its conversation
// leaves the experiment rather than joining the control group, since an arm on a conversation that was never going to
// be sent a map would read as a measured nothing.
test("a persona that drops the map gets none of it, however the sandbox is set", async () => {
    const root = await projectAt("wsmap-card-", "shared");
    const lean: Persona = { id: "lean", capabilities: [], briefing: { omit: ["map"] } };
    const services = servicesIn(
        root,
        { workspaceMap: true, workspaceMapHoldout: 0.5 },
        {
            personas: unstubbed<Services["personas"]>("personas", { list: async () => [lean] }),
            agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
        },
    );
    const turn = { prompt: "do the thing", actsAs: "lean", conversationId: "conv-lean" } as AgentTurn;

    const plan = await planTurn(services, turn, contextIn(root));

    expect(plan).toMatchObject({ ok: true });
    const request = (plan as { request: AgentRequest }).request;
    expect(composeWirePrompt(request.spec.notes ?? [], request.spec.prompt)).toBe(composeWirePrompt([OPENING_CHECKS_NOTE], "do the thing"));
    expect(plan).not.toHaveProperty("experiments.mapArm");
});

// Round-trips through the same registry dispatch uses (turn-preamble.ts INJECTED); this is what catches a note shipped
// with a header the parser doesn't know.
test("the map strips back off the stored message, and the chat is given a row for it", async () => {
    const root = await projectAt("wsmap-strip-", "shared");

    const prompt = await promptOf(servicesIn(root, { workspaceMap: true }), { prompt: "do the thing" } as AgentTurn, contextIn(root));

    expect(stripTurnPreamble(prompt)).toBe("do the thing");
    expect(preambleNotes(prompt).map((note) => note.title)).toEqual(["Map of this project", LANDING_CHECKS_NOTE_TITLE]);
});

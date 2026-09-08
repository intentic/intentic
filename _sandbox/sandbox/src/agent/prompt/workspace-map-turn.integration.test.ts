import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createCredentialGrants } from "../../secrets/credential-grants.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTurn, DEFAULT_SAFETY_POLICY, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { testConfig } from "../../testing.js";
import { workspaceSetup } from "../../workspace/layout/workspace-setup.js";
import type { AgentRequest } from "../run/agent.js";
import { planTurn, type TurnContext } from "../run/turn/turn-plan.js";
import { composeWirePrompt, preambleNotes, stripTurnPreamble } from "./turn-preamble.js";
import { WORKSPACE_MAP_NOTE_HEADER } from "./workspace-map.js";

// Pins the four turn-plan gates around the workspace map (the generator itself has its own suite): off must mean off,
// sent once per conversation, honoured on every runtime, and built against the run's actual tree, not the shared
// checkout.

vi.mock("../providers/harness-credentials.js", () => ({
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

// The model's message comes from CONTEXT.base.prompt, not the turn's; attachments are already folded in by then.
const contextIn = (root: string, localCwd = root, prompt = "do the thing"): TurnContext => ({
    base: { prompt, cwd: root, signal: new AbortController().signal },
    attachmentPaths: [],
    localCwd,
    effectiveCwd: localCwd,
    cliEnv: {},
    steering: undefined,
});

const servicesIn = (root: string, settings: Partial<Record<string, unknown>>, overrides: Partial<Services> = {}): Services =>
    unstubbed<Services>("services", {
        tools: [],
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
        perf: unstubbed<Services["perf"]>("perf", { track: (_op, _fields, run) => run() }),
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [{ name: "sub", label: "sub" }], grok: [], kimi: [], gemini: [] }),
        }),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        // Read once per turn and carried for the judge: every planned turn reaches it, map or no map.
        safetyPolicy: unstubbed<Services["safetyPolicy"]>("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
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
    return composeWirePrompt(request.notes ?? [], request.prompt);
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

    expect(prompt).toBe("do the thing");
});

test("a follow-up in the same conversation is not charged for the map again", async () => {
    const root = await projectAt("wsmap-again-", "shared");
    const services = servicesIn(
        root,
        { workspaceMap: true },
        {
            // Non-zero `turns` means the conversation already carries the map in its own transcript.
            agents: unstubbed<Services["agents"]>("agents", { entry: () => ({ turns: 3 }) as ReturnType<Services["agents"]["entry"]> }),
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

// Round-trips through the same registry dispatch uses (turn-preamble.ts INJECTED); this is what catches a note shipped
// with a header the parser doesn't know.
test("the map strips back off the stored message, and the chat is given a row for it", async () => {
    const root = await projectAt("wsmap-strip-", "shared");

    const prompt = await promptOf(servicesIn(root, { workspaceMap: true }), { prompt: "do the thing" } as AgentTurn, contextIn(root));

    expect(stripTurnPreamble(prompt)).toBe("do the thing");
    expect(preambleNotes(prompt).map((note) => note.title)).toContain("Map of this project");
});

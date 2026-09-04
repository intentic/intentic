import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createCredentialGrants } from "../secrets/credential-grants.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTurn, DEFAULT_SAFETY_POLICY, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { testConfig } from "../testing.js";
import { workspaceSetup } from "../workspace/workspace-setup.js";
import type { AgentRequest } from "./agent.js";
import { planTurn, type TurnContext } from "./turn-plan.js";
import { composeWirePrompt, preambleNotes, stripTurnPreamble } from "./turn-preamble.js";
import { WORKSPACE_MAP_NOTE_HEADER } from "./workspace-map.js";

/* WHO ACTUALLY RECEIVES THE PROJECT MAP: the gates, asserted through a real plan rather than by reading them.
 *
 * The generator has its own suite (workspace-map.integration.test.ts); this file is about the four decisions
 * around it that live in turn-plan, and each one is a way the feature fails silently rather than loudly:
 *
 *   OFF MEANS OFF. An opt-in that leaks would spend the owner's tokens on a setting they never turned on, and
 *   nothing in the transcript would look wrong.
 *
 *   ONCE PER CONVERSATION. The map is stable and already above the follow-up in the transcript, so re-sending it
 *   is the exact repetition the dependency notice had to be walked back from: invisible, and paid every turn.
 *
 *   EVERY RUNTIME, not just the Claude Code loop. It is placed in honoured() for the reason the worktree note
 *   and the dependency notice are: a fact about the filesystem is as true of a Codex turn, and the harness arm
 *   is the one place that reaches only one of the six.
 *
 *   AND IT FOLLOWS THE RUN, which is the whole feature: a turn whose tree is an isolated worktree must be told
 *   about THAT tree. Getting this wrong produces a note that is well-formed, plausible, and about a directory
 *   the turn cannot edit. */

vi.mock("./harness-credentials.js", () => ({
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

// The message the model actually receives is built from the CONTEXT's prompt, not the turn's: the route has
// already folded attachments into it by the time a plan is made, so the tests below read it back from here.
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
        // Nothing gated: planTurn narrows the manifest once for every runtime, so the approval policy is
        // read on every turn whether or not a gate exists (secrets/credential-gating.ts).
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

// What the model will actually read: the plan's typed notes serialized in front of its prompt, by the same
// function dispatch uses (agent.routes.ts, composeWirePrompt).
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
            // The registry counts every turn that ran, however it ended: a non-zero count is a conversation already
            // carrying the map in its own transcript.
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

/* THE STARTING POSITION, and the one case where getting it wrong is invisible.
 *
 * An isolated conversation edits a worktree, and the daemon reaches that worktree at `localCwd` while the shared
 * checkout still sits at the workspace root. A map built from the root would name the root's areas: real
 * directories, plausibly described, and not the ones this turn can write to. The two trees are given different
 * area descriptions here precisely so that a map of the wrong one cannot pass. */
test("an isolated turn is mapped against its own tree, not the shared checkout", async () => {
    const sharedMarker = "shared";
    const branchMarker = "branch";
    const root = await projectAt("wsmap-root-", sharedMarker);
    const worktree = await projectAt("wsmap-wt-", branchMarker);

    const prompt = await promptOf(servicesIn(root, { workspaceMap: true }), { prompt: "do the thing" } as AgentTurn, contextIn(root, worktree));

    expect(prompt).toContain(`The ${branchMarker} billing area`);
    expect(prompt).not.toContain(`The ${sharedMarker} billing area`);
});

/* THE NOTE IS PROTOCOL, NOT SOMETHING THE USER SAID, and the PROVIDER's store keeps the composed prompt
 * verbatim, so the boundary parser must still recognize it there (history menu, adoption, search). This is the
 * round trip: the same serialization dispatch performs, read back by the parser, which is what fails if a note
 * ships typed with a header the parser's registry does not know, and what keeps the two vocabularies from
 * drifting apart (turn-preamble.ts, INJECTED). */
test("the map strips back off the stored message, and the chat is given a row for it", async () => {
    const root = await projectAt("wsmap-strip-", "shared");

    const prompt = await promptOf(servicesIn(root, { workspaceMap: true }), { prompt: "do the thing" } as AgentTurn, contextIn(root));

    expect(stripTurnPreamble(prompt)).toBe("do the thing");
    expect(preambleNotes(prompt).map((note) => note.title)).toContain("Map of this project");
});

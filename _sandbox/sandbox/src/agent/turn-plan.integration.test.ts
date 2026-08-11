import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTurn, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { testConfig } from "../testing.js";
import { SETUP_NOTICE_HEADER, STALE_NOTICE_HEADER, workspaceSetup } from "../workspace/workspace-setup.js";
import type { AgentRequest } from "./agent.js";
import { planTurn, type TurnContext } from "./turn-plan.js";

/* EVERY RUNTIME IS TOLD THE TREE IS BEHIND — BY WHATEVER SEAM IT HAS. Asserted here rather than in the unit
 * suite because the only way to earn a dependency notice is to have a tree that has earned one.
 *
 * The fact itself is the one a turn cannot deduce and will otherwise be misled by: an unresolved import is the
 * install being behind, not the code being wrong. It used to live in the harness arm, so a Codex or Grok session
 * read a wall of true-looking type errors with nothing telling it why; honoured() is the one point all four arms
 * pass through, which is why the decision lives there and why this walks more than one arm.
 *
 * WHAT DIFFERS PER RUNTIME IS THE DELIVERY, on the rule this function already applies to the worktree note: a
 * note is second-best to a mechanism, and belongs only where the mechanism cannot go. A `full` runtime is handed
 * readiness TOOLS and two hooks that fire on a real failure, each addressed to the turn that actually went near
 * a drifted project — so pushing the paragraph as well would charge every other turn in the conversation for
 * three facts it never needed, on every turn, for as long as the drift lasted. The native runtimes have no seam
 * for either, so for them the paragraph is still the whole of the defence and still arrives.
 *
 * The cost is that a brief run on Claude and on Codex is no longer byte-identical while something is behind.
 * That is a real loss and a deliberate one: it is bounded to a state the reconciler's heartbeat now repairs
 * between turns, and the alternative was paying for it on every turn of every conversation forever.
 */

// The harness arm's credential resolution, which is a question about the owner's accounts rather than about the
// tree — stubbed so the Claude case below can reach the part this file is actually asserting on. The native arms
// never call it.
vi.mock("./harness-credentials.js", () => ({
    resolveHarnessCredentials: async () => ({ ok: true, credentials: { oauthToken: "***", account: "acc-1" } }),
}));

const workspaceWithMissingDeps = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "turn-plan-"));
    // A manifest and no install: `node_modules` is the recipe's marker, so its absence is the whole state.
    await writeFile(join(root, "package.json"), `{"name":"app","dependencies":{"left-pad":"^1.0.0"}}`);
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    return root;
};

/* An ISOLATED turn's tree as the DAEMON reaches it: the source is checked out, and every installed dependency
 * is an empty directory. That is not a broken worktree, it is the ordinary one — the real tree arrives as an
 * overlay mounted inside the turn's own namespace (agents/worktrees.ts), which the daemon is not in. */
const daemonSideWorktree = async (): Promise<string> => {
    const worktree = await mkdtemp(join(tmpdir(), "turn-plan-wt-"));
    await writeFile(join(worktree, "package.json"), `{"name":"app","dependencies":{"left-pad":"^1.0.0"}}`);
    await writeFile(join(worktree, "pnpm-lock.yaml"), "");
    await mkdir(join(worktree, "node_modules"), { recursive: true });
    return worktree;
};

const contextIn = (root: string, localCwd = root): TurnContext => ({
    base: { prompt: "do the thing", cwd: root, signal: new AbortController().signal },
    attachmentPaths: [],
    localCwd,
    effectiveCwd: localCwd,
    cliEnv: {},
    syncNote: undefined,
    steering: undefined,
});

// A translator holding the ChatGPT subscription, which is what both native arms below authenticate against.
const servicesIn = (root: string, overrides: Partial<Services> = {}): Services =>
    unstubbed<Services>("services", {
        tools: [],
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        processes: unstubbed<Services["processes"]>("processes", { running: () => false }),
        dependencies: unstubbed<Services["dependencies"]>("dependencies", {
            status: () => workspaceSetup(root, unstubbed<Services["processes"]>("processes", { running: () => false })),
            issueAt: async () => undefined,
        }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        // Every turn resolves a persona now, above the provider split, so every arm below reaches this — a
        // workspace with no cards is the open attended posture these tests already assume.
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [] }),
        // A measurement seam, not a behavioural one: pass the work through and time nothing.
        perf: unstubbed<Services["perf"]>("perf", { track: (_op, _fields, run) => run() }),
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [{ name: "sub", label: "sub" }], grok: [], kimi: [], gemini: [] }),
        }),
        codexAgent: async function* () {},
        grokAgent: async function* () {},
        ...overrides,
    });

const promptOf = async (services: Services, turn: AgentTurn, context: TurnContext): Promise<string> => {
    const plan = await planTurn(services, turn, context);
    expect(plan).toMatchObject({ ok: true });
    return (plan as { request: AgentRequest }).request.prompt;
};

/* The harness arm, which is the one that got the mechanism — and so the one that must no longer get the prose.
 *
 * A workspace this size regularly sits a few packages behind for hours at a time, and the paragraph was
 * re-stapled to the front of every message in every conversation for the whole of it. Nothing in it was untrue;
 * it was addressed to every turn instead of to the one that tripped over something. */
test("a Claude turn gets the readiness tools instead of the paragraph, however far behind the tree is", async () => {
    const root = await workspaceWithMissingDeps();
    const services = servicesIn(root, {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        // The delegation note asks which other coding agents this sandbox can hand work to; none, here.
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
        codexAgent: async function* () {},
        agent: async function* () {},
    });

    const plan = await planTurn(services, { prompt: "do the thing" } as AgentTurn, contextIn(root));
    expect(plan).toMatchObject({ ok: true });
    const request = (plan as { request: AgentRequest }).request;

    expect(request.prompt).toBe("do the thing");
    expect(request.sdkServers?.["deps"]).toBeDefined();
    // The daemon-side readers still have to be able to find the real tree: an isolated turn's cwd names its
    // worktree, where every dependency directory is an empty mount point.
    expect(request.workspaceRoot).toBe(root);
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
    expect(prompt).toContain("ask the owner to install it");
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
    });
    const resumed = contextIn(root);
    const prompt = await promptOf(services, { prompt: "do the thing", agent: "codex" } as AgentTurn, {
        ...resumed,
        base: { ...resumed.base, sessionId: "codex-session-1" },
    });

    expect(prompt).toBe("do the thing");
});

test("a native Grok turn hears it too — the note belongs to the tree, not to the runtime", async () => {
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

test("an installed tree earns no notice, so an ordinary turn is the user's message and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "turn-plan-"));
    const services = servicesIn(root, {
        codexThreadExists: async () => true,
        codexModels: unstubbed<Services["codexModels"]>("codexModels", {
            models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
        }),
    });

    const prompt = await promptOf(services, { prompt: "do the thing", agent: "codex" } as AgentTurn, contextIn(root));

    expect(prompt).toBe("do the thing");
});

/* THE PROBE HAS TO ASK ABOUT THE TREE THE TURN RESOLVES THROUGH, which for an isolated turn is never the
 * worktree the daemon can see. Everything a worktree's imports resolve through is mounted into the turn's own
 * namespace and is an empty directory anywhere else — so a probe run daemon-side found the marker, walked it,
 * found nothing, and declared the whole workspace uninstalled. Against this repository that was 663 phantom
 * dependencies and three paragraphs of untrue instruction in front of every isolated turn, telling the model to
 * distrust type errors that were fine and to expect imports to fail that did not. */
test("an isolated turn is not told its dependencies are missing just because the daemon cannot see them", async () => {
    const main = await mkdtemp(join(tmpdir(), "turn-plan-"));
    const services = servicesIn(main, {
        codexThreadExists: async () => true,
        codexModels: unstubbed<Services["codexModels"]>("codexModels", {
            models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
        }),
    });

    const prompt = await promptOf(services, { prompt: "do the thing", agent: "codex" } as AgentTurn, contextIn(main, await daemonSideWorktree()));

    // Neither half of it — a worktree read daemon-side has the marker, so it earns the STALE wording rather
    // than the never-installed one, and that is the half nothing was anchored on.
    expect(prompt).not.toContain(STALE_NOTICE_HEADER);
    expect(prompt).not.toContain(SETUP_NOTICE_HEADER);
    // The worktree note is a different fact and still belongs: this runtime reaches its branch by cwd alone.
    expect(prompt.endsWith("do the thing")).toBe(true);
});

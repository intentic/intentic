import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurn } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { testConfig } from "../testing.js";
import { SETUP_NOTICE_HEADER } from "../workspace/workspace-setup.js";
import type { AgentRequest } from "./agent.js";
import { planTurn, type TurnContext } from "./turn-plan.js";

/* THE SAME REQUEST HAS TO ARRIVE AS THE SAME MESSAGE, whichever runtime serves it — asserted here rather than
 * in the unit suite because the only way to earn a dependency notice is to have a tree that has earned one.
 *
 * It is not a nicety. The dependency notice is the one fact a turn cannot deduce and will otherwise be misled
 * by (an unresolved import is the install being behind, not the code being wrong), and it lived in the harness
 * arm — so a Codex or Grok session read a wall of true-looking type errors with nothing telling it why. It also
 * made "two models, one task" a rigged comparison: identical briefs, one of them silently longer, and the only
 * variable that workflow exists to isolate no longer isolated. honoured() is the one point all four arms pass
 * through, which is why the note lives there and why this walks more than one arm.
 */

const workspaceWithMissingDeps = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "turn-plan-"));
    // A manifest and no install: `node_modules` is the recipe's marker, so its absence is the whole state.
    await writeFile(join(root, "package.json"), `{"name":"app","dependencies":{"left-pad":"^1.0.0"}}`);
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    return root;
};

const contextIn = (root: string): TurnContext => ({
    base: { prompt: "do the thing", cwd: root, signal: new AbortController().signal },
    attachmentPaths: [],
    localCwd: root,
    effectiveCwd: root,
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
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
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

test("a native Codex turn is told the tree's dependencies are missing, exactly as a Claude turn is", async () => {
    const root = await workspaceWithMissingDeps();
    const services = servicesIn(root, {
        codexThreadExists: async () => true,
        codexModels: unstubbed<Services["codexModels"]>("codexModels", {
            models: async () => ({ models: [{ id: "gpt-5.6-codex", label: "GPT 5.6 Codex" }], default: "gpt-5.6-codex" }),
        }),
    });

    const prompt = await promptOf(services, { prompt: "do the thing", agent: "codex" } as AgentTurn, contextIn(root));

    expect(prompt).toContain(SETUP_NOTICE_HEADER);
    // The user's own words still end the message: the notice is a preamble, not a replacement.
    expect(prompt.endsWith("do the thing")).toBe(true);
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

import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentTurn, RoutedAgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import type { TurnContext } from "../../agent/providers/adapter.js";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { createLogger } from "../../logger.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { testConfig } from "../../env.config.testing.js";
import { testTurnMounts } from "../../agent/tools/turn-mounts.testing.js";
import { rootExecution } from "../../workload/agent-execution.testing.js";
import type { AcpTurnOptions } from "../acp/acp-agent.js";
import type { AcpLaunch } from "../acp/acp-spawn.js";
import { GROK_BUILD } from "../grok-build/grok-build-cli.js";
import { KIMI_CLI } from "../kimi-cli/kimi-cli.js";
import type { StoredCliAccount } from "./vendor-cli-store.js";
import type { CliTurnDeps } from "./vendor-cli-turn.js";
import * as vendorCliOriginal from "./vendor-cli.js";

/* How a turn on a vendor CLI's loop is planned: which account's home serves, which model, and what a dead sign-in says. */

jest.mock("./vendor-cli.js", () => ({ ...vendorCliOriginal, cliBinary: async () => "/opt/cli/bin/cli" }));
const { planCliTurn } = await import("./vendor-cli-turn.js");

const ROOT = "/nowhere/cli-plan";
const cards = parkedCards(memoryFleet().conversations);

const account = (id: string, over: Partial<StoredCliAccount> = {}): StoredCliAccount => ({ id, connectedAt: 0, ...over });

interface Ran {
    readonly id: string;
    readonly launch: AcpLaunch;
    readonly options: AcpTurnOptions | undefined;
}

const harness = (accounts: StoredCliAccount[], replies: AgentEvent[] = [{ kind: "done" }]) => {
    const ran: Ran[] = [];
    const written: StoredCliAccount[] = [];
    const parts = {
        store: unstubbed<Parameters<typeof planCliTurn>[1]["store"]>("store", {
            accounts: async () => accounts,
            read: async (id: string) => accounts.find((entry) => entry.id === id),
            write: async (stored: StoredCliAccount) => {
                written.push(stored);
            },
            homeOf: (id: string) => `/auth/homes/${id}`,
            logger: createLogger(testConfig),
        }),
        models: unstubbed<Parameters<typeof planCliTurn>[1]["models"]>("models", {
            models: async () => ({
                models: [
                    { id: "kimi-k3", label: "Kimi K3" },
                    { id: "kimi-k2", label: "Kimi K2" },
                ],
                default: "kimi-k3",
            }),
        }),
    };
    const services = unstubbed<CliTurnDeps>("services", {
        tools: [],
        config: testConfig,
        ...testTurnMounts(),
        capabilities: unstubbed("capabilities", { list: async () => [] }),
        workspace: unstubbed("workspace", { root: ROOT }),
        // What the daemon's own servers read as they are built (daemon-servers.ts); none is called by a plan.
        conversations: unstubbed("conversations", {}),
        usage: unstubbed("usage", { turns: async () => [] }),
        dependencies: unstubbed("dependencies", {}),
        agents: unstubbed("agents", { entry: () => undefined }),
        logger: createLogger(testConfig),
        async *acpAgent(id: string, launch: AcpLaunch, _request: AgentRequest, options?: AcpTurnOptions) {
            ran.push({ id, launch, options });
            yield* replies;
        },
    });
    return { services, parts, ran, written };
};

const execution = rootExecution({ localCwd: ROOT });
afterAll(() => execution.release());

const context: TurnContext = {
    base: {
        execution: execution.context,
        spec: { prompt: "hi", cwd: ROOT },
        policy: {},
        tools: {},
        hooks: { cards },
        signal: new AbortController().signal,
    },
    attachmentPaths: [],
    localCwd: ROOT,
    effectiveCwd: ROOT,
    cliEnv: {},
    steering: undefined,
    settings: SandboxSettingsSchema.parse({}),
};

const turn = (over: Partial<AgentTurn> = {}): RoutedAgentTurn =>
    // SAFETY: a plan reads only these fields of the routed turn; routing's own additions are not consulted.
    ({ prompt: "hi", conversationId: "conv-1", agent: "kimi", harness: "vendor", ...over }) as RoutedAgentTurn;

const run = async (h: ReturnType<typeof harness>, input: RoutedAgentTurn, cli = KIMI_CLI): Promise<AgentEvent[]> => {
    const plan = await planCliTurn(cli, h.parts, h.services, input, context, []);
    if (!plan.ok) {
        throw new Error(plan.message);
    }
    const events: AgentEvent[] = [];
    for await (const event of plan.run(plan.request.spec)) {
        events.push(event);
    }
    return events;
};

test("with nothing signed in the turn is refused with the sign-in fix", async () => {
    const h = harness([]);
    const plan = await planCliTurn(KIMI_CLI, h.parts, h.services, turn(), context, []);
    expect(plan).toEqual(
        expect.objectContaining({ ok: false, code: "subscription-required", message: expect.stringContaining("Sign in to Kimi CLI") }),
    );
});

test("the first account's home serves, its own CLI process, on the model the turn names", async () => {
    const h = harness([account("a"), account("b")]);
    await run(h, turn({ model: "kimi-k2" }));
    expect(h.ran).toEqual([
        {
            id: "kimi-cli:a",
            launch: { argv: ["/opt/cli/bin/cli", "acp"], env: { KIMI_CODE_HOME: "/auth/homes/a", KIMI_CODE_NO_AUTO_UPDATE: "1" } },
            options: { model: "kimi-k2" },
        },
    ]);
});

test("Grok Build runs its own agent, unshared, with its ask-user tool switched off", async () => {
    const h = harness([account("g")]);
    await run(h, turn({ agent: "grok" }), GROK_BUILD);
    expect(h.ran[0]).toEqual(
        expect.objectContaining({
            id: "grok-build:g",
            launch: {
                argv: ["/opt/cli/bin/cli", "agent", "--no-leader", "stdio"],
                env: { GROK_HOME: "/auth/homes/g", GROK_DISABLE_AUTOUPDATER: "1" },
                sessionMeta: { askUserQuestion: false },
            },
        }),
    );
});

test("a pinned account serves, and a model the account does not offer runs on its own default", async () => {
    const h = harness([account("a"), account("b")]);
    await run(h, turn({ account: "b", model: "kimi-k3-256k" }));
    expect(h.ran[0]).toEqual(expect.objectContaining({ id: "kimi-cli:b", options: { model: "kimi-k3" } }));
});

// A conversation that moved from Claude Code to the CLI's loop still pins the translator's account; that names no CLI home.
test("a pin naming another credential's account falls to the first signed-in one", async () => {
    const h = harness([account("a")]);
    await run(h, turn({ account: "kimi-translator.json" }));
    expect(h.ran[0]?.id).toBe("kimi-cli:a");
});

test("a turn refused as signed out marks the account for a new sign-in and says where", async () => {
    const h = harness([account("a")], [{ kind: "error", code: "acp-auth-required", message: "Authentication required" }, { kind: "done" }]);
    const events = await run(h, turn());
    expect(h.written).toEqual([expect.objectContaining({ id: "a", refusedAt: expect.any(Number) })]);
    expect(events[0]).toEqual({ kind: "error", message: expect.stringContaining("Sandbox ▸ Models"), own: true });
});

test("every sign-in refused: the turn is refused before spawning, naming the new sign-in", async () => {
    const h = harness([account("a", { refusedAt: 1 })]);
    const plan = await planCliTurn(KIMI_CLI, h.parts, h.services, turn(), context, []);
    expect(plan).toEqual({ ok: false, message: expect.stringContaining("Sign in to it again") });
    expect(h.ran).toEqual([]);
});

test("the daemon's own servers ride the turn's remote list, with the relay the loop attaches", async () => {
    const h = harness([account("a")]);
    const plan = await planCliTurn(KIMI_CLI, h.parts, h.services, turn(), context, []);
    if (!plan.ok) {
        throw new Error(plan.message);
    }
    expect(plan.request.tools.remote?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ui", "watch", "deps"]));
    expect(plan.request.hooks.relay).toMatchObject({ attach: expect.any(Function), push: expect.any(Function) });
});

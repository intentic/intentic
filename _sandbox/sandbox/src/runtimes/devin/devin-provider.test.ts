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
import type { StoredDevinAccount } from "./accounts/devin-credentials.js";
import * as devinCliOriginal from "./devin-cli.js";

/* How a Devin turn is planned: which account serves, which model the session is put on, and what a dead key says. */

jest.mock("./devin-cli.js", () => ({ ...devinCliOriginal, devinCli: async () => "/opt/devin/bin/devin" }));
const { planDevinTurn } = await import("./devin-provider.js");

const ROOT = "/nowhere/devin-plan";
const cards = parkedCards(memoryFleet().conversations);

const account = (id: string, over: Partial<StoredDevinAccount> = {}): StoredDevinAccount => ({ id, apiKey: `key-${id}`, connectedAt: 0, ...over });

interface Ran {
    readonly id: string;
    readonly launch: AcpLaunch;
    readonly options: AcpTurnOptions | undefined;
}

const harness = (accounts: StoredDevinAccount[], replies: AgentEvent[] = [{ kind: "done" }]) => {
    const ran: Ran[] = [];
    const written: StoredDevinAccount[] = [];
    const services = {
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
        devinStore: unstubbed("devinStore", {
            credentials: async () => accounts,
            read: async (id: string) => accounts.find((entry) => entry.id === id),
            write: async (stored: StoredDevinAccount) => {
                written.push(stored);
            },
            logger: createLogger(testConfig),
        }),
        devinModels: unstubbed("devinModels", {
            models: async () => ({
                models: [
                    { id: "swe-1-6", label: "SWE-1.6" },
                    { id: "opus", label: "Claude Opus" },
                ],
                default: "swe-1-6",
            }),
        }),
        async *acpAgent(id: string, launch: AcpLaunch, _request: AgentRequest, options?: AcpTurnOptions) {
            ran.push({ id, launch, options });
            yield* replies;
        },
    };
    return { services: services as unknown as Parameters<typeof planDevinTurn>[0], ran, written };
};

// A registered execution: running the planned loop checks the request's authority before anything spawns.
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
    ({ prompt: "hi", conversationId: "conv-1", agent: "devin", harness: "native", ...over }) as RoutedAgentTurn;

const run = async (services: Parameters<typeof planDevinTurn>[0], input: RoutedAgentTurn): Promise<AgentEvent[]> => {
    const plan = await planDevinTurn(services, input, context, []);
    if (!plan.ok) {
        throw new Error(plan.message);
    }
    const events: AgentEvent[] = [];
    for await (const event of plan.run(plan.request.spec)) {
        events.push(event);
    }
    return events;
};

test("with nothing connected the turn is refused with the connect fix", async () => {
    const plan = await planDevinTurn(harness([]).services, turn(), context, []);
    expect(plan).toEqual(expect.objectContaining({ ok: false, code: "subscription-required" }));
});

test("the first connected account serves, signed in over the protocol, on the model the turn names", async () => {
    const { services, ran } = harness([account("a"), account("b")]);
    await run(services, turn({ model: "opus" }));
    expect(ran).toEqual([
        {
            id: "devin:a",
            launch: { argv: ["/opt/devin/bin/devin", "acp"], env: {}, authenticate: { meta: { api_key: "key-a" } } },
            options: { model: "opus" },
        },
    ]);
});

test("a pinned account serves, and a model the account no longer offers falls back to its default", async () => {
    const { services, ran } = harness([account("a"), account("b")]);
    await run(services, turn({ account: "b", model: "gone" }));
    expect(ran[0]).toEqual(expect.objectContaining({ id: "devin:b", options: { model: "swe-1-6" } }));
});

test("the catalog's floor leaves the session on the account's own model", async () => {
    const { services, ran } = harness([account("a")]);
    const floor = {
        ...services,
        devinModels: unstubbed("devinModels", {
            models: async () => ({ models: [{ id: "default", label: "Devin's default" }], default: "default" }),
        }),
    };
    await run(floor as typeof services, turn());
    expect(ran[0]?.options).toEqual({});
});

test("a turn refused as signed out marks the account for a new sign-in and says where", async () => {
    const { services, written } = harness(
        [account("a")],
        [{ kind: "error", code: "acp-auth-required", message: "Please log in to use Devin." }, { kind: "done" }],
    );
    const events = await run(services, turn());
    expect(written).toEqual([expect.objectContaining({ id: "a", refusedAt: expect.any(Number) })]);
    expect(events[0]).toEqual({ kind: "error", message: expect.stringContaining("Sandbox ▸ Models"), own: true });
});

test("every key refused: the turn is refused before spawning, naming the reconnect", async () => {
    const plan = await planDevinTurn(harness([account("a", { refusedAt: 1 })]).services, turn(), context, []);
    expect(plan).toEqual({ ok: false, message: expect.stringContaining("Connect your Devin account again") });
});

// The daemon's own servers ride the same door lease as the floor's mounts (daemon-servers.ts), and the loop gets the relay
// they reach the running turn through.
test("the daemon's own servers ride the turn's remote list, with the relay the loop attaches", async () => {
    const plan = await planDevinTurn(harness([account("a")]).services, turn(), context, []);
    if (!plan.ok) {
        throw new Error(plan.message);
    }
    expect(plan.request.tools.remote?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ui", "watch", "deps"]));
    expect(plan.request.hooks.relay).toMatchObject({ attach: expect.any(Function), push: expect.any(Function) });
});

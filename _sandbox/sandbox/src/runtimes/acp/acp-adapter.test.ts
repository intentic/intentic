import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AgentTurn, RoutedAgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import type { TurnContext } from "../../agent/providers/adapter.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { createLogger } from "../../logger.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { testConfig } from "../../env.config.testing.js";
import { testTurnMounts } from "../../agent/tools/turn-mounts.testing.js";
import { rootExecution } from "../../workload/agent-execution.testing.js";
import type { AcpTurnOptions } from "./acp-agent.js";
import { type AcpAdapterDeps, planAcpTurn } from "./acp-adapter.js";

/* How a turn on an installed ACP agent is planned: which model its session is asked to run. */

const ROOT = "/nowhere/acp-plan";
const cards = parkedCards(memoryFleet().conversations);
const QWEN: Capability = { id: "qwen", kind: "agent", config: { command: "qwen --acp", name: "Qwen Code" } };

const harness = () => {
    const ran: (AcpTurnOptions | undefined)[] = [];
    const services = unstubbed<AcpAdapterDeps>("services", {
        tools: [],
        config: testConfig,
        ...testTurnMounts(),
        capabilities: unstubbed("capabilities", { list: async () => [QWEN] }),
        workspace: unstubbed("workspace", { root: ROOT }),
        // What the daemon's own servers read as they are built (daemon-servers.ts); none is called by a plan.
        conversations: unstubbed("conversations", {}),
        usage: unstubbed("usage", { turns: async () => [] }),
        dependencies: unstubbed("dependencies", {}),
        agents: unstubbed("agents", { entry: () => undefined }),
        logger: createLogger(testConfig),
        async *acpAgent(_id, _launch, _request, options) {
            ran.push(options);
            yield { kind: "done" } satisfies AgentEvent;
        },
    });
    return { services, ran };
};

// A registered execution: running the planned loop checks the request's authority before anything spawns.
const execution = rootExecution({ localCwd: ROOT });
afterAll(() => execution.release());

const contextOf = (sealed: boolean): TurnContext => ({
    base: {
        execution: execution.context,
        spec: { prompt: "hi", cwd: ROOT },
        policy: sealed ? { sealed: true } : {},
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
});

const turn = (over: Pick<AgentTurn, "model"> = {}): RoutedAgentTurn => ({ prompt: "hi", conversationId: "conv-1", agent: "qwen", harness: "native", ...over });

const optionsOf = async (input: RoutedAgentTurn, sealed = false): Promise<AcpTurnOptions | undefined> => {
    const { services, ran } = harness();
    const plan = await planAcpTurn(services, input, contextOf(sealed), [QWEN], "qwen");
    if (!plan.ok) {
        throw new Error(plan.message);
    }
    const events: AgentEvent[] = [];
    for await (const event of plan.run(plan.request.spec)) {
        events.push(event);
    }
    expect(events).toEqual([{ kind: "done" }]);
    return ran[0];
};

// On 2026-11-22 a Qwen Code subagent spawned on `qwen4-max` ran on the agent's own default: the arm never passed it on.
test("a turn naming a model asks the agent's session for it, sealed or not", async () => {
    expect(await optionsOf(turn({ model: "qwen4-max" }))).toEqual({ model: "qwen4-max" });
    expect(await optionsOf(turn({ model: "qwen4-max" }), true)).toEqual({ model: "qwen4-max" });
});

// The picker offers an installed agent no model list and sends its row's empty id.
test("a turn naming no model, or the picker's empty one, leaves the agent its own pick", async () => {
    expect(await optionsOf(turn())).toEqual({});
    expect(await optionsOf(turn({ model: "" }))).toEqual({});
});

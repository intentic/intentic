import type { AgentTurn, Capability } from "@intentic/sandbox-contract";
import { type AgentAdapter, attemptProbe, healthReady, healthUnavailable, healthUnknown } from "../agent/adapter.js";
import { withAttachments } from "../agent/attachment-note.js";
import type { TurnContext, TurnPlan } from "../agent/turn-plan.js";
import { hostToolsOf } from "../capabilities/host-tools.js";
import { webextToolsOf } from "../capabilities/webext-tools.js";
import { mcpToolsOf } from "../capabilities/mcp-tools.js";
import type { Services } from "../composition.js";

/* The generic ACP row: any provider id outside the native six is an installed `agent`-kind capability served
 * over the Agent Client Protocol. Beside the runtime it serves rather than in the registry's table file, the
 * same siting rule the native providers follow (provider-module.ts) — but a plain adapter, not a module: ACP
 * agents are capabilities, so their catalog, credentials and packs are the capability system's business. */

// An ACP provider: the id of an installed `agent`-kind capability, spawned and driven over the Agent Client
// Protocol. Harness doesn't apply (the agent IS its own loop) and neither do the Claude-only request fields;
// the adapter passes http MCP tools through when the agent advertises support.
export const planAcpTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
    provider: string,
): Promise<TurnPlan> => {
    const capability = granted.find((entry) => entry.kind === "agent" && entry.id === provider);
    if (capability === undefined || capability.kind !== "agent") {
        return { ok: false, message: `Unknown agent provider "${provider}", add it as an Agent capability first.` };
    }
    const acpConfig = capability.config;
    const tools = [...services.tools, ...mcpToolsOf(granted), ...hostToolsOf(granted, services.config.sandbox.port, services.hostBridgeToken),
        ...webextToolsOf(granted, services.config.sandbox.port, services.webextBridgeToken),
    ];
    return {
        ok: true,
        run: (turnRequest) => services.acpAgent(provider, acpConfig, turnRequest),
        request: withAttachments(tools.length > 0 ? { ...context.base, tools } : context.base, context.attachmentPaths),
    };
};

export const ACP_ADAPTER: AgentAdapter<"acp"> = {
    runtime: "acp",
    preflight: (services, input, context, installed) => planAcpTurn(services, input, context, installed, input.agent ?? "claude"),
    /* An ACP agent carries its own credentials, installed IS runnable, so the only thing that can be wrong is
     * that nothing is installed. Per-agent liveness (does its binary still spawn) is deliberately not probed
     * here: it would mean spawning every installed agent on a timer, and the pool already reports a spawn
     * failure as the turn's own coded refusal. */
    health: async (services) => {
        const installed = await attemptProbe(() => services.capabilities.list());
        if (installed === undefined) {
            return healthUnknown();
        }
        return installed.some((capability) => capability.kind === "agent")
            ? healthReady()
            : healthUnavailable("Add an Agent capability to run an ACP agent here.");
    },
    /* An ACP session lives inside the agent's own process and there is no store to ask from out here, so this
     * answers for the only case that reaches a turn: the pool spawns the agent, and it either replays the
     * session or says it cannot (acp-agent.ts asks it directly, at resume time). Answering "gone" from here
     * would retire every ACP session on a daemon that simply cannot see them. */
    holdsSession: async () => true,
};

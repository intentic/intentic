import type { AgentTurn, Capability } from "@intentic/sandbox-contract";
import { type AgentAdapter, attemptProbe, healthReady, healthUnavailable, healthUnknown } from "../../agent/providers/adapter.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import type { TurnContext, TurnPlan } from "../../agent/run/turn/turn-plan.js";
import { peerToolsOf } from "../../peers/peer-tools.js";
import { mcpToolsOf } from "../../capabilities/mcp-tools.js";
import type { Services } from "../../composition.js";

// Any provider id outside the native six is an installed `agent`-kind capability served over the Agent Client Protocol.
// Sited beside the runtime it serves, like the native providers, but a plain adapter, not a module: an ACP agent's
// catalog, credentials and packs are the capability system's business.

// Harness doesn't apply here, the agent is its own loop, and neither do the Claude-only request fields; MCP tools pass
// through when the agent advertises support.
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
    const tools = [
        ...services.tools,
        ...mcpToolsOf(granted),
        ...peerToolsOf("host", granted, services.config.sandbox.port, services.hostBridgeToken),
        ...peerToolsOf("webext", granted, services.config.sandbox.port, services.webextBridgeToken),
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
    // Installed is runnable, since an ACP agent carries its own credentials; the only failure here is nothing
    // installed. Liveness per agent isn't probed; a spawn failure surfaces as the turn's own refusal instead.
    health: async (services) => {
        const installed = await attemptProbe(() => services.capabilities.list());
        if (installed === undefined) {
            return healthUnknown();
        }
        return installed.some((capability) => capability.kind === "agent")
            ? healthReady()
            : healthUnavailable("Add an Agent capability to run an ACP agent here.");
    },
    // Always true: a session lives inside the agent's own process, with no store to ask out here. The pool asks the
    // agent directly at resume time (acp-agent.ts); answering "gone" here would retire every session blindly.
    holdsSession: async () => true,
};

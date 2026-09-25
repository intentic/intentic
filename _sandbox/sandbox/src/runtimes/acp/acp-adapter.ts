import type { AgentTurn, Capability } from "@intentic/sandbox-contract";
import {
    type AgentAdapter,
    armPlan,
    attemptProbe,
    healthReady,
    healthUnavailable,
    healthUnknown,
    type TurnArmPlan,
    type TurnContext,
} from "../../agent/providers/adapter.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import { turnToolsOf } from "../../agent/tools/turn-tools.js";
import { releasingBrowsers } from "../../browser/tools/browser-fields.js";
import type { Services } from "../../composition.js";

// Any provider id outside the native six is an installed `agent`-kind capability served over the Agent Client Protocol.
// Sited beside the runtime it serves, like the native providers, but a plain adapter, not a module: an ACP agent's
// catalog, credentials and packs are the capability system's business.

// What the ACP adapter reads: the installed manifest, the daemon's tools it passes through, and the warm connection pool.
export type AcpAdapterDeps = Pick<
    Services,
    "acpAgent" | "capabilities" | "config" | "extensionMcpMounts" | "files" | "hostBridgeToken" | "tools" | "webextBridgeToken" | "workspace"
>;

// Harness doesn't apply here, the agent is its own loop, and neither do the Claude-only request fields; MCP tools pass
// through when the agent advertises support.
export const planAcpTurn = async (
    services: AcpAdapterDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
    provider: string,
): Promise<TurnArmPlan> => {
    const capability = granted.find((entry) => entry.kind === "agent" && entry.id === provider);
    if (capability === undefined || capability.kind !== "agent") {
        return { ok: false, message: `Unknown agent provider "${provider}", add it as an Agent capability first.` };
    }
    const acpConfig = capability.config;
    const mounted = await turnToolsOf(services, granted, input.conversationId);
    const tools = mounted.tools;
    return armPlan(
        // The agent's warm session keeps the mount bearer across turns; the release only empties it until the next.
        releasingBrowsers((request) => services.acpAgent(provider, acpConfig, request), mounted),
        withAttachments(
            {
                ...context.base,
                tools: tools.length > 0 ? { ...context.base.tools, remote: tools } : context.base.tools,
                credential: { kind: "container" },
            },
            context.attachmentPaths,
        ),
    );
};

export const ACP_ADAPTER: AgentAdapter<"acp", AcpAdapterDeps> = {
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

import type { Capability,RoutedAgentTurn} from "@intentic/sandbox-contract";
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
import { releasingMounts } from "../../agent/tools/turn-mounts.js";
import { turnToolsOf, type TurnToolsDeps } from "../../agent/tools/turn-tools.js";
import type { Services } from "../../composition.js";

// Any provider id outside the native six is an installed `agent`-kind capability served over the Agent Client Protocol.
// Sited beside the runtime it serves, like the native providers, but a plain adapter, not a module: an ACP agent's
// catalog, credentials and packs are the capability system's business.

// What the ACP adapter reads: the installed manifest, the daemon's tools it passes through, and the warm connection pool.
export type AcpAdapterDeps = TurnToolsDeps & Pick<Services, "acpAgent" | "capabilities" | "config" | "files" | "workspace">;

// Harness doesn't apply here, the agent is its own loop, and neither do the Claude-only request fields; the turn's MCP
// servers, browsers included, pass through when the agent advertises http MCP.
export const planAcpTurn = async (
    services: AcpAdapterDeps,
    input: RoutedAgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
    provider: string,
): Promise<TurnArmPlan> => {
    const capability = granted.find((entry) => entry.kind === "agent" && entry.id === provider);
    if (capability === undefined || capability.kind !== "agent") {
        return { ok: false, message: `Unknown agent provider "${provider}", add it as an Agent capability first.` };
    }
    const acpConfig = capability.config;
    // Resolved by planTurn; without one the turn is the open, attended default, which may drive the credential-free browser.
    const mounted = await turnToolsOf(services, granted, {
        conversationId: input.conversationId,
        anonymousBrowser: context.persona?.powers.browser ?? true,
    });
    const tools = mounted.tools;
    return armPlan(
        // The agent's warm session keeps the conversation's bearer and each server's URL across turns; the release only
        // empties what the bearer reaches until the next turn leases it again.
        releasingMounts((request) => services.acpAgent(provider, acpConfig, request), mounted),
        withAttachments(
            {
                ...context.base,
                // The browser stack's facts (ports, output dir) feed the Claude Code hooks and observer, which an ACP agent
                // has none of: its browsers are servers in `remote` like everything else.
                tools: tools.length > 0 ? { ...context.base.tools, remote: tools } : context.base.tools,
                credential: { kind: "container" },
            },
            context.attachmentPaths,
        ),
    );
};

export const ACP_ADAPTER: AgentAdapter<"acp", AcpAdapterDeps> = {
    runtime: "acp",
    preflight: (services, input, context, installed) => planAcpTurn(services, input, context, installed, input.agent),
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

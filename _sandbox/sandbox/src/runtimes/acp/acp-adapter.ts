import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { RoutedAgentTurn } from "@intentic/sandbox-contract/schemas/agent";
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
import { withAttachments } from "../../sessions/vocabulary/attachment-note.js";
import { releasingMounts } from "../../agent/tools/turn-mounts.js";
import { turnToolsOf, type TurnToolsDeps } from "../../agent/tools/turn-tools.js";
import type { Services } from "../../composition.js";
import { turnPersona } from "../../personas/personas.js";
import { opt } from "../../opt.js";
import { commandListOf, publishedCommandOf } from "../../agent/providers/agent-commands.js";
import { assertAgentExecutionContext } from "../../workload/agent-execution.js";
import { type DaemonServersDeps, daemonServersFor } from "../daemon-tools/daemon-servers.js";
import { acpLaunchOf } from "./acp-spawn.js";

// Any provider id outside the native ones is an installed `agent`-kind capability served over the Agent Client Protocol.
// Sited beside the runtime it serves, like the native providers, but a plain adapter, not a module: an ACP agent's
// catalog, credentials and packs are the capability system's business.

// What the ACP adapter reads: the installed manifest, the daemon's tools it passes through, and the warm connection pool.
export type AcpAdapterDeps = TurnToolsDeps &
    DaemonServersDeps &
    Pick<Services, "acpAgent" | "capabilities" | "config" | "files" | "workspace" | "sandboxSettings">;

// Harness doesn't apply here, the agent is its own loop, and neither do the Claude-only request fields; the turn's MCP
// servers, browsers included, and the daemon's own (daemon-servers.ts) reach the agent over http where it advertises
// http MCP, else through the daemon's stdio proxy (acp-mcp-proxy.ts).
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
    const launch = acpLaunchOf(capability.config);
    // Resolved by planTurn; without one the turn is the open, attended default, which may drive the credential-free browser.
    // A warm session keeps the MCP config it was opened with, so its turns share the conversation's bearer.
    const mounted = await turnToolsOf(services, granted, {
        conversationId: input.conversationId,
        anonymousBrowser: context.persona?.powers.browser ?? true,
        shell: context.persona?.powers.shell ?? true,
        extensions: context.persona?.powers.extensions,
        warmSession: true,
    });
    // The daemon's own servers ride the same lease, so the warm session's bearer reaches them on every turn it serves; a
    // server a later turn adds (a persona change) is not seen until a new session opens. The agent's own permission asks
    // already reach the gate in-process (acp-agent.ts), so no gate server.
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    const settings = context.settings ?? (await services.sandboxSettings.get());
    const daemon = daemonServersFor(services, { input, context, persona, granted, settings, mounted, gate: false });
    const tools = [...mounted.tools, ...daemon.tools];
    return armPlan(
        // The agent's warm session keeps the conversation's bearer and each server's URL across turns; the release only
        // empties what the bearer reaches until the next turn leases it again.
        releasingMounts((request) => services.acpAgent(provider, launch, request), mounted),
        withAttachments(
            {
                ...context.base,
                // A message opening with one of the agent's own commands is sent with that command first (acp-agent.ts).
                spec: { ...context.base.spec, ...opt("command", publishedCommandOf(commandListOf(provider, input.harness), context.base.spec.prompt)) },
                // The browser stack's facts (ports, output dir) feed the Claude Code hooks and observer, which an ACP agent
                // has none of: its browsers are servers in `remote` like everything else.
                tools: { ...context.base.tools, ...opt("remote", tools.length > 0 ? tools : undefined), diagnostics: daemon.diagnostics },
                hooks: { ...context.base.hooks, relay: daemon.relay },
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
    holdsSession: async (_services, _sessionId, execution) => {
        assertAgentExecutionContext(execution);
        return true;
    },
};

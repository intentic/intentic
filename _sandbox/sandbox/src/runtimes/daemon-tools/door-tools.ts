import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { TurnContext } from "../../agent/providers/adapter.js";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { turnToolsOf, type TurnRemoteTools, type TurnToolsDeps } from "../../agent/tools/turn-tools.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { turnPersona } from "../../personas/personas.js";
import { turnSecretAccess } from "../../agent/run/harness/harness-servers.js";
import { type DaemonServersDeps, daemonServersFor } from "./daemon-servers.js";

// Step 1 of DAEMON-TOOLS-WIRING.md in one call, for a planner whose runtime reaches MCP over HTTP: the turn's remote
// servers (turnToolsOf: the door's browsers, machines and extension tools), then the daemon's own servers (ui, accounts,
// secrets, subagents, watch, deps, diagnostics, code) on the same lease, and the relay the loop attaches its stream,
// watchdog and gate to. The turn's secret seam is set on the request too, the one the daemon's servers resolve through,
// so a loop that runs its own shell (OpenCode's, runtimes/opencode/shell/opencode-shell.ts) resolves and masks by the
// same one. Used by the OpenCode planners (Grok, Gemini).

export type DoorToolsDeps = TurnToolsDeps & DaemonServersDeps & Pick<Services, "sandboxSettings">;

export interface DoorTools {
    // Released by the loop the plan arms (releasingMounts); every daemon server rides it and closes with it.
    readonly mounted: TurnRemoteTools;
    readonly tools: AgentRequest["tools"];
    readonly hooks: AgentRequest["hooks"];
}

/**
 * Leases the turn's mounts and the daemon's servers on them. Called last in a planner, once nothing can refuse the turn:
 * only the loop it arms releases the lease, so a refusal after this would leak it.
 */
export const doorToolsOf = async (
    services: DoorToolsDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
    // Mount the policy gate server, for a runtime whose own hooks call it (daemon-servers.ts); a runtime that asks the
    // daemon over its own permission channel gains nothing from three more tools.
    gate: boolean,
): Promise<DoorTools> => {
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    // Read before the lease opens, so a settings read that throws leaves nothing leased.
    const settings = context.settings ?? (await services.sandboxSettings.get());
    const mounted = await turnToolsOf(services, granted, {
        conversationId: input.conversationId,
        anonymousBrowser: persona.powers.browser,
        shell: persona.powers.shell,
        extensions: persona.powers.extensions,
    });
    try {
        const secrets = context.base.tools.secrets ?? turnSecretAccess(services, input, context.base.signal);
        const withSecrets: TurnContext = { ...context, base: { ...context.base, tools: { ...context.base.tools, secrets } } };
        const daemon = daemonServersFor(services, { input, context: withSecrets, persona, granted, settings, mounted, gate });
        const remote = [...mounted.tools, ...daemon.tools];
        return {
            mounted,
            tools: { ...withSecrets.base.tools, ...opt("remote", remote.length > 0 ? remote : undefined), diagnostics: daemon.diagnostics },
            hooks: { ...context.base.hooks, relay: daemon.relay },
        };
    } catch (error) {
        mounted.release();
        throw error;
    }
};

import type { AcpAgentConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { PI_PROVIDER } from "@intentic/sandbox-contract/models/agent-catalog";
import type { CapabilityHandler } from "../capability.js";

// Agent capabilities speak ACP, except the reserved Pi id, which speaks Pi RPC. A missing Pi CLI is pending so its
// card can be saved before the image rebuild that installs it. Other agents must answer ACP initialize at add time.
export const agentHandler: CapabilityHandler = {
    // The whole pasted KEY=VALUE env block, credentials ride in it (the vpn-conf precedent).
    secret: (config) => ((config as AcpAgentConfig).env !== undefined ? "env" : undefined),
    echo: (config) => {
        const agent = config as AcpAgentConfig;
        return {
            command: agent.command,
            ...(agent.name !== undefined ? { name: agent.name } : {}),
            ...(agent.loginCommand !== undefined ? { loginCommand: agent.loginCommand } : {}),
            hasSecret: agent.env !== undefined && agent.env !== "",
        };
    },
    // Nothing outside the manifest carries the name: the command and its env are the whole capability, and the
    // warm connection keyed by the old one is dropped by the route exactly as an edit drops it.
    rename: {},
    async *apply(ctx, id, config) {
        // SAFETY: the capability route parses an agent-kind config as AcpAgentConfig before dispatching here.
        const agent = config as AcpAgentConfig;
        if (id === PI_PROVIDER) {
            const probe = await ctx.probePiAgent(agent, ctx.workspace.root);
            yield { kind: "log", message: probe.detail ?? "Pi RPC connected." };
            return;
        }
        const probe = await ctx.probeAcpAgent(agent, ctx.workspace.root);
        const name = probe.agentName ?? id;
        yield {
            kind: "log",
            message: `Connected to ${name} over ACP (protocol v${probe.protocolVersion}), it appears as a provider in the chat picker.`,
        };
    },
    status: async (ctx, id, config) => {
        try {
            // SAFETY: stored agent-kind capabilities have already passed the AcpAgentConfig schema.
            const agent = config as AcpAgentConfig;
            if (id === PI_PROVIDER) {
                return await ctx.probePiAgent(agent, ctx.workspace.root);
            }
            const probe = await ctx.probeAcpAgent(agent, ctx.workspace.root);
            return { state: "active", detail: `ACP v${probe.protocolVersion}` };
        } catch (error) {
            return { state: "error", detail: error instanceof Error ? error.message : "probe failed" };
        }
    },
    remove: async () => {},
};

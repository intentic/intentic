import type { AcpAgentConfig } from "@intentic/sandbox-contract";
import { probeAcpAgent } from "../../acp/acp-probe.js";
import type { CapabilityHandler } from "../capability.js";

// An ACP agent: a chat provider. apply/status = a spawn + initialize probe, proving the command actually
// speaks ACP (and surfacing its stderr when it doesn't) before the first chat turn depends on it. The warm
// turn-serving connection lives in the acp pool; the capability route drops it on remove/edit so a config
// change respawns cleanly.
export const agentHandler: CapabilityHandler = {
    // The whole pasted KEY=VALUE env block — credentials ride in it (the vpn-conf precedent).
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
    apply: async function* (ctx, id, config) {
        const probe = await probeAcpAgent(config as AcpAgentConfig, ctx.workspace.root);
        const name = probe.agentName ?? id;
        yield {
            kind: "log",
            message: `Connected to ${name} over ACP (protocol v${probe.protocolVersion}) — it appears as a provider in the chat picker.`,
        };
    },
    status: async (ctx, _id, config) => {
        try {
            const probe = await probeAcpAgent(config as AcpAgentConfig, ctx.workspace.root);
            return { state: "active", detail: `ACP v${probe.protocolVersion}` };
        } catch (error) {
            return { state: "error", detail: error instanceof Error ? error.message : "probe failed" };
        }
    },
    remove: async () => {},
};

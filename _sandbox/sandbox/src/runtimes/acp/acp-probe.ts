import { type AgentCapabilities, client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AcpAgentConfig } from "@intentic/sandbox-contract";
import { withTimeout } from "./acp-connection.js";
import { parseEnvBlock, spawnAcpProcess } from "./acp-spawn.js";

/* One-shot ACP probe for the `agent` capability handler: spawn the command, initialize, report what the agent
 * advertises, kill. Proves the command actually speaks ACP before the capability reads active, a wrong
 * binary fails here with its stderr, not on the user's first chat turn. Deliberately standalone (no pool):
 * the warm turn-serving connection is acp-connection's concern. */

const PROBE_TIMEOUT_MS = 15_000;

export interface AcpProbeResult {
    readonly protocolVersion: number;
    readonly capabilities: AgentCapabilities;
    readonly agentName: string | undefined;
}

export const probeAcpAgent = async (config: AcpAgentConfig, cwd: string): Promise<AcpProbeResult> => {
    const proc = spawnAcpProcess(config.command, parseEnvBlock(config.env), cwd);
    try {
        const conn = client({ name: "intentic-probe" }).connect(proc.stream);
        // Hard timeout race. SDK request cancellation is cooperative, so a non-ACP binary would hang forever.
        const init = await withTimeout(
            conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            }),
            PROBE_TIMEOUT_MS,
        ).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : "initialize failed";
            const detail = proc.stderrTail().trim();
            throw new Error(detail === "" ? `not an ACP agent: ${reason}` : `not an ACP agent: ${reason}: ${detail}`);
        });
        return {
            protocolVersion: init.protocolVersion,
            capabilities: init.agentCapabilities ?? {},
            agentName: init.agentInfo?.name,
        };
    } finally {
        proc.child.kill();
    }
};

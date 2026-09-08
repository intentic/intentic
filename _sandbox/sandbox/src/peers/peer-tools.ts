import type { Capability } from "@intentic/sandbox-contract";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import { PEER_BRIDGES } from "./peer.js";

// Points at this daemon's per-boot bridge token, never the peer's own enrollment token. `conversationId` in the URL
// only lets the bridge judge a call in context; it grants nothing.
export const peerToolsOf = (
    kind: keyof typeof PEER_BRIDGES,
    capabilities: readonly Capability[],
    daemonPort: number,
    bridgeToken: string,
    conversationId?: string,
): AgentTool[] => {
    const forConversation = conversationId === undefined ? `` : `?conversation=${encodeURIComponent(conversationId)}`;
    return capabilities.flatMap((capability) =>
        capability.kind === kind
            ? [{ name: capability.id, url: `http://127.0.0.1:${daemonPort}/mcp/${PEER_BRIDGES[kind]}/${capability.id}${forConversation}`, token: bridgeToken }]
            : [],
    );
};

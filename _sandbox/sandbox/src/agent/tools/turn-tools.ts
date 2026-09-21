import type { Capability } from "@intentic/sandbox-contract";
import { mcpToolsOf } from "../../capabilities/mcp-tools.js";
import type { Services } from "../../composition.js";
import { peerToolsOf } from "../../peers/peer-tools.js";
import type { AgentTool } from "./agent-tools.js";

// Every remote MCP endpoint a turn may reach: the daemon's own internal tools, the workspace's mcp-kind capabilities,
// and the peer bridges to connected machines and browsers. One composer for every runtime that takes http tools, so a
// capability the owner connected can't reach one loop and miss another. Internal first; a same-named external
// capability overrides, matching mcpServersOf's last-wins merge.
export const turnToolsOf = (
    services: Pick<Services, "tools" | "config" | "hostBridgeToken" | "webextBridgeToken">,
    granted: readonly Capability[],
    conversationId?: string,
): AgentTool[] => [
    ...services.tools,
    ...mcpToolsOf(granted),
    // The conversation rides the host bridge's URL alone: it only lets the command gate judge a call in context.
    ...peerToolsOf("device", granted, services.config.sandbox.port, services.hostBridgeToken, conversationId),
    ...peerToolsOf("webext", granted, services.config.sandbox.port, services.webextBridgeToken),
];

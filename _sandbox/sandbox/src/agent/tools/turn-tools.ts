import type { Capability } from "@intentic/sandbox-contract";
import { mcpToolsOf } from "../../capabilities/mcp-tools.js";
import type { Services } from "../../composition.js";
import { extensionMcpToolsOf } from "../../extensions/backend/extension-mcp.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { peerToolsOf } from "../../peers/peer-tools.js";
import type { AgentTool } from "./agent-tools.js";

// Every remote MCP endpoint a turn may reach: the daemon's own internal tools, the workspace's mcp-kind capabilities,
// the peer bridges to connected machines and browsers, and the MCP endpoints extension cards serve from the backend
// host. One composer for every runtime that takes http tools, so a capability the owner connected can't reach one loop
// and miss another. Internal first; a same-named external capability overrides, matching mcpServersOf's last-wins merge.
export const turnToolsOf = async (
    services: Pick<Services, "tools" | "config" | "hostBridgeToken" | "webextBridgeToken" | "extensionMcpToken"> & ExtensionHost,
    granted: readonly Capability[],
    conversationId?: string,
): Promise<AgentTool[]> => [
    ...services.tools,
    ...mcpToolsOf(granted),
    // The conversation rides the host bridge's URL alone: it only lets the command gate judge a call in context.
    ...peerToolsOf("device", granted, services.config.sandbox.port, services.hostBridgeToken, conversationId),
    ...peerToolsOf("webext", granted, services.config.sandbox.port, services.webextBridgeToken),
    ...(await extensionMcpToolsOf(services, granted, services.config.sandbox.port)),
];

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// One agent tool: a remote MCP endpoint (URL, optional scoped bearer). Internal tools arrive base64-encoded via
// INTENTIC_AGENT_TOOLS; external ones per turn in the agent request body; both become remote `http` MCP servers.
export const agentToolSchema = z.object({
    // MCP server name; surfaces to the model as `mcp__<name>__<tool>` (service id for internal tools).
    name: z.string().min(1),
    url: z.url(),
    // The scoped bearer sent as `Authorization: Bearer <token>`. Absent for unauthenticated endpoints.
    token: z.string().optional(),
});
export type AgentTool = z.infer<typeof agentToolSchema>;

// Decodes env-injected internal tools; connect.sh / the workspace provider base64-encode the JSON so it rides `docker
// -e` cleanly. Empty or absent means no internal tools; malformed input throws.
export const internalTools = (encoded: string | undefined): AgentTool[] => {
    if (encoded === undefined || encoded === "") {
        return [];
    }
    const json = Buffer.from(encoded, "base64").toString("utf8");
    return z.array(agentToolSchema).parse(JSON.parse(json));
};

// A later entry with the same name wins, letting external config override an internal default. Servers are deferred
// behind ToolSearch rather than pinned; a device's skill and the deferred-tool list handle discoverability.
export const mcpServersOf = (tools: readonly AgentTool[]): Record<string, McpServerConfig> => {
    const servers: Record<string, McpServerConfig> = {};
    for (const tool of tools) {
        servers[tool.name] = {
            type: "http",
            url: tool.url,
            ...(tool.token !== undefined ? { headers: { Authorization: `Bearer ${tool.token}` } } : {}),
        };
    }
    return servers;
};

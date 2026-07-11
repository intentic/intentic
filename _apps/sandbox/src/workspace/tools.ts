import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// One agent tool: a remote MCP endpoint reached by URL with an optional scoped bearer token. Two sources feed
// this, both shaped identically: intent-declared INTERNAL tools arrive base64-encoded in INTENTIC_AGENT_TOOLS
// (connect.sh or the workspace provider sets that env), and user-configured EXTERNAL tools arrive per turn in
// the agent request body. Both become remote `http` MCP servers on the Claude Agent SDK.
export const agentToolSchema = z.object({
    // The MCP server name; surfaces to the model as `mcp__<name>__<tool>`. Service id for internal tools.
    name: z.string().min(1),
    url: z.string().url(),
    // The scoped bearer sent as `Authorization: Bearer <token>`. Absent for unauthenticated endpoints.
    token: z.string().optional(),
});
export type AgentTool = z.infer<typeof agentToolSchema>;

// Decode the env-injected internal tools. connect.sh / the workspace provider base64-encode the JSON so
// braces/quotes ride the `docker -e` value cleanly; absent/empty ⇒ no internal tools. A malformed value throws.
export const internalTools = (encoded: string | undefined): AgentTool[] => {
    if (encoded === undefined || encoded === "") {
        return [];
    }
    const json = Buffer.from(encoded, "base64").toString("utf8");
    return z.array(agentToolSchema).parse(JSON.parse(json));
};

// Build the SDK `mcpServers` map from a tool list. Tools are `alwaysLoad` so a small, curated set stays
// present in the prompt instead of being deferred behind tool search — best agent performance for known tools.
// A later entry with the same name wins (lets external config override an internal default).
export const mcpServersOf = (tools: readonly AgentTool[]): Record<string, McpServerConfig> => {
    const servers: Record<string, McpServerConfig> = {};
    for (const tool of tools) {
        servers[tool.name] = {
            type: "http",
            url: tool.url,
            alwaysLoad: true,
            ...(tool.token !== undefined ? { headers: { Authorization: `Bearer ${tool.token}` } } : {}),
        };
    }
    return servers;
};

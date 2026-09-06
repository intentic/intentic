import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// One agent tool: a remote MCP endpoint reached by URL with an optional scoped bearer token. Two sources feed
// this, both shaped identically: intent-declared INTERNAL tools arrive base64-encoded in INTENTIC_AGENT_TOOLS
// (connect.sh or the workspace provider sets that env), and user-configured EXTERNAL tools arrive per turn in
// the agent request body. Both become remote `http` MCP servers on the Claude Agent SDK.
export const agentToolSchema = z.object({
    // The MCP server name; surfaces to the model as `mcp__<name>__<tool>`. Service id for internal tools.
    name: z.string().min(1),
    url: z.url(),
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

/* Build the SDK `mcpServers` map from a tool list. A later entry with the same name wins (lets external config
 * override an internal default).
 *
 * DEFERRED behind tool search, the SDK's default, where these used to be pinned (`alwaysLoad`) "for best agent
 * performance on known tools". The pin was measured on 2026-09-06 over this workspace's 327 sessions since
 * 08-29: the three connected computers here were reached in 9, 7 and 1 of them, while each rode every call of
 * all 327 as 25 tool schemas (~3k tokens apiece), and the SDK blocks turn start on a pinned server's connect
 * for up to 5s, so an offline laptop stalled every turn. Deferred, a server costs nothing until ToolSearch
 * pulls it in, and the servers that already WERE deferred show the model finds them: `web` in 40% of
 * sessions, `deps` in 16%. Discoverability is a sentence's job, not a schema's: a device's skill names every
 * tool and how to load them (hosts/host-skills.ts), and the deferred-tool list in the prompt carries the
 * names of the rest. */
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

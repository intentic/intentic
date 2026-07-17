import type { Capability } from "@intentic/sandbox-contract";
import type { AgentTool } from "../agent/agent-tools.js";

// The agent's external MCP servers, derived from mcp-kind capabilities in the manifest (replacing the old
// tools.json store). Merged after the intent-declared internal tools each turn — see agent.routes.
export const mcpToolsOf = (capabilities: readonly Capability[]): AgentTool[] =>
    capabilities.flatMap((capability) =>
        capability.kind === "mcp"
            ? [
                  {
                      name: capability.id,
                      url: capability.config.url,
                      ...(capability.config.token !== undefined ? { token: capability.config.token } : {}),
                  },
              ]
            : [],
    );

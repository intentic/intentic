import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { opt } from "../opt.js";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { TurnLease } from "../agent/tools/turn-mounts.js";
import { mcpBearerOf, mcpSessionOf } from "./mcp-oauth/mcp-session.js";

// The agent's external MCP servers, derived from mcp-kind capabilities in the manifest (replacing the old
// tools.json store). Merged after the intent-declared internal tools each turn, see agent.routes.
// A server signed in to through the sandbox (mcp-oauth/) is mounted on the turn's lease instead, when there is one: the
// turn's MCP door attaches its access token, renewed as it lapses, so the agent holds only the turn's own bearer. With
// no lease (the daemon's own calls to a server's app) it carries the access token as it stands.
export const mcpToolsOf = (capabilities: readonly Capability[], lease?: Pick<TurnLease, "open">): AgentTool[] =>
    capabilities.flatMap((capability): AgentTool[] => {
        if (capability.kind !== "mcp") {
            return [];
        }
        if (lease !== undefined && mcpSessionOf(capability.config.token) !== undefined) {
            return [lease.open({ name: capability.id, target: { kind: "remote", capability: capability.id } })];
        }
        const bearer = mcpBearerOf(capability.config.token);
        return [{ name: capability.id, url: capability.config.url, ...opt("token", bearer) }];
    });

import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { opt } from "../opt.js";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { TurnLease } from "../agent/tools/turn-mounts.js";
import { mcpBearerOf } from "./mcp-oauth/mcp-session.js";

// The agent's external MCP servers, derived from mcp-kind capabilities in the manifest (replacing the old
// tools.json store). Merged after the intent-declared internal tools each turn, see agent.routes.
// A turn reaches every one through its lease on the daemon's MCP door (mcp-oauth/mcp-remote.ts), never at its own
// address: the door attaches the card's credential (a pasted token, or a sign-in's access token renewed as it lapses),
// so the agent holds only the turn's own bearer, and it is where a `{{secret:…}}` reference in a call's arguments
// becomes its value and the answer is masked again, for every runtime alike. With no lease (the daemon's own calls to a
// server's app) a card carries its credential as it stands. Until 2026-11-25 a pasted token's server was handed to the
// runtime at its own address, token and all, so nothing between the agent and it could resolve or mask anything.
export const mcpToolsOf = (capabilities: readonly Capability[], lease?: Pick<TurnLease, "open">): AgentTool[] =>
    capabilities.flatMap((capability): AgentTool[] => {
        if (capability.kind !== "mcp") {
            return [];
        }
        if (lease !== undefined) {
            return [lease.open({ name: capability.id, target: { kind: "remote", capability: capability.id } })];
        }
        const bearer = mcpBearerOf(capability.config.token);
        return [{ name: capability.id, url: capability.config.url, ...opt("token", bearer) }];
    });

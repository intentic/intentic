import type { Capability } from "@intentic/sandbox-contract";
import type { AgentTool } from "../agent/agent-tools.js";

/* The agent's tools for the user's own computers, the parallel to mcpToolsOf, with one difference that is the
 * whole security design: the URL points at THIS DAEMON, not at the machine.
 *
 * A laptop behind NAT has no address to put in an MCP config, so the daemon's loopback bridge (/mcp/hosts/<id>,
 * hosts/host.routes.ts) stands in for it and forwards over the socket the machine itself opened. The bearer is
 * therefore the per-boot bridge token, a handle that only works from inside this container and dies with the
 * daemon, and never the machine's enrollment token, which lives on /history precisely so that the agent cannot
 * read it. What the handle can actually do is bounded on the far end, by the scopes that machine enforces.
 *
 * The tool NAME is the capability id, so the model sees mcp__laptop__run_command and mcp__desktop__run_command
 * as distinct tools on distinct machines, the `ssh` alias precedent, and what makes several connected computers
 * usable in one turn. */
export const hostToolsOf = (capabilities: readonly Capability[], daemonPort: number, bridgeToken: string): AgentTool[] =>
    capabilities.flatMap((capability) =>
        capability.kind === "host"
            ? [{ name: capability.id, url: `http://127.0.0.1:${daemonPort}/mcp/hosts/${capability.id}`, token: bridgeToken }]
            : [],
    );

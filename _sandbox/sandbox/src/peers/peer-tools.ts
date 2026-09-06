import type { Capability } from "@intentic/sandbox-contract";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import { PEER_BRIDGES } from "./peer.js";

/* The agent's tools for the user's own peers, the parallel to mcpToolsOf with one difference that is the whole
 * security design: the URL points at THIS DAEMON, not at the peer.
 *
 * A laptop behind NAT has no address to put in an MCP config, and an extension in somebody's Chrome has no
 * address at all, so the daemon's loopback bridge (/mcp/<slug>/<id>, peers/peer-routes.ts) stands in for it and
 * forwards over the socket the peer itself opened. The bearer is therefore the per-boot bridge token, a handle
 * that only works from inside this container and dies with the daemon, and never the peer's enrollment token,
 * which lives on /history precisely so that the agent cannot read it. What the handle can actually do is
 * bounded on the far end, by the scopes that peer enforces.
 *
 * The tool NAME is the capability id, so the model sees mcp__laptop__run_command and mcp__desktop__run_command
 * as distinct tools on distinct machines, the `ssh` alias precedent, and what makes several connected peers
 * usable in one turn.
 *
 * WHY THE CONVERSATION RIDES IN THE URL. The bridge may judge a call against the owner's safety policy before
 * forwarding it (hosts/host-command-gate.ts), and judging needs the turn: which conversation to draw the
 * permission card in, whether that turn has taken in outside content, whether anybody is watching. None of that
 * is derivable from a bearer token shared by every peer in the sandbox, so the caller states it. It is NOT a
 * credential and it grants nothing: the bridge token is still the only thing that opens this route, and an
 * agent that rewrote its own conversation id would only misaddress its own card. */
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

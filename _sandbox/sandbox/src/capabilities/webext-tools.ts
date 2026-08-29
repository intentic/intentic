import type { Capability } from "@intentic/sandbox-contract";
import type { AgentTool } from "../agent/agent-tools.js";

/* The agent's tools for the user's own BROWSERS — hostToolsOf one layer in, and the same security shape: the
 * URL points at THIS DAEMON, never at the browser.
 *
 * An extension in somebody's Chrome has no address at all — it is not a server, and it exists only while the
 * browser is open — so the daemon's loopback bridge (/mcp/webext/<id>, webext/webext.routes.ts) stands in for
 * it and forwards over the socket the extension itself opened. The bearer is therefore the per-boot bridge
 * token, which only works from inside this container and dies with the daemon, and never the extension's
 * enrollment token, which lives on /history precisely so the agent cannot read it.
 *
 * The tool NAME is the capability id, so the model sees mcp__my-chrome__click and mcp__work-edge__click as
 * distinct tools on distinct browsers — the `host` precedent, and what makes two connected browsers usable in
 * one turn without either becoming "the" browser. */
export const webextToolsOf = (capabilities: readonly Capability[], daemonPort: number, bridgeToken: string): AgentTool[] =>
    capabilities.flatMap((capability) =>
        capability.kind === "webext"
            ? [{ name: capability.id, url: `http://127.0.0.1:${daemonPort}/mcp/webext/${capability.id}`, token: bridgeToken }]
            : [],
    );

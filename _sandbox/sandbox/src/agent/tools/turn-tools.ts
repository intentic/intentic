import type { Capability } from "@intentic/sandbox-contract";
import { browserServersOf, type BrowserTurnTools } from "../../browser/tools/browser-tools.js";
import { mcpToolsOf } from "../../capabilities/mcp-tools.js";
import type { Services } from "../../composition.js";
import { extensionMcpToolsOf } from "../../extensions/backend/extension-mcp.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { peerToolsOf } from "../../peers/peer-tools.js";
import type { AgentTool } from "./agent-tools.js";

// A turn's remote MCP servers, the browser stack's facts the prompt and the session observer read, and the release its
// loop calls when the turn ends: the conversation's bearer stops reaching this turn's mounts then, and its browser
// routers close.
export interface TurnRemoteTools {
    readonly tools: AgentTool[];
    readonly browser: BrowserTurnTools;
    readonly release: () => void;
}

export type TurnToolsDeps = Pick<Services, "tools" | "turnMounts" | "browserRouters"> & ExtensionHost;

// Every MCP server a turn may reach, as one list every runtime projects the same way: the daemon's own internal tools,
// the workspace's mcp-kind capabilities, and, through the daemon's one MCP door on a lease of this turn's own, the
// connected machines and browsers it was granted, its extension cards' endpoints and its browser routers. One composer
// for every runtime, so a capability the owner connected can't reach one loop and miss another. Internal first; a
// same-named later entry overrides, matching mcpServersOf's last-wins merge, so the browsers (reserved names) come last.
export const turnToolsOf = async (
    services: TurnToolsDeps,
    granted: readonly Capability[],
    turn: {
        readonly conversationId?: string | undefined;
        // Whether the persona may drive a browser at all (its `browser` power); signed-in accounts ride their cards.
        readonly anonymousBrowser: boolean;
    },
): Promise<TurnRemoteTools> => {
    const lease = services.turnMounts.lease(turn.conversationId);
    try {
        const [extension, browser] = await Promise.all([
            extensionMcpToolsOf(services, granted, lease),
            browserServersOf(granted, services.workspace.root, { routers: services.browserRouters, lease }, turn.anonymousBrowser, turn.conversationId),
        ]);
        return {
            tools: [
                ...services.tools,
                ...mcpToolsOf(granted),
                ...peerToolsOf("device", granted, lease),
                ...peerToolsOf("webext", granted, lease),
                ...extension,
                ...browser.servers,
            ],
            browser,
            release: lease.release,
        };
    } catch (error) {
        lease.release();
        throw error;
    }
};

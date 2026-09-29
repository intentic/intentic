import { createHash, randomBytes } from "node:crypto";
import type { McpRemoteConfig, SessionPromptAsyncData } from "@opencode-ai/sdk";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import { opt } from "../../opt.js";

// A turn's MCP servers on the one shared `opencode serve`: the same remote list Codex and ACP agents take (the daemon's
// MCP door's browsers, machines and extension tools, and the mcp-kind cards), each server carrying the turn's bearer.
// OpenCode keeps MCP servers per directory rather than per session, and offers every session there every server's
// tools, while two conversations often share one directory. So a conversation's servers are mounted under names of
// its own, `intentic_<key>_<server>`, and every prompt shows its session those and hides everyone else's. A tool's key
// is OpenCode's own spelling, `<server>_<tool>` with both sanitized, which is what the session's rules match.

// What every server this runtime mounts is named from; the one pattern a prompt hides.
const PREFIX = "intentic_";

// OpenCode's own sanitizing of a server or tool name into a tool key (its mcp/catalog.ts `sanitize`).
const sanitized = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

export interface OpenCodeMounts {
    // `intentic_<key>_`, the conversation's own: its tool names hold still from turn to turn, and so does the tool list
    // a provider caches the prompt behind.
    readonly prefix: string;
    readonly tools: readonly AgentTool[];
}

// One server as OpenCode's `mcp.add` takes it.
export interface OpenCodeMcpServer {
    readonly name: string;
    readonly config: McpRemoteConfig;
}

// Keyed by a hash of the conversation, so the name carries nothing of its id; a turn with no conversation gets a key of
// its own.
export const openCodeMounts = (conversationId: string | undefined, tools: readonly AgentTool[]): OpenCodeMounts => {
    const key = conversationId === undefined ? randomBytes(4).toString("hex") : createHash("sha256").update(conversationId).digest("hex").slice(0, 8);
    return { prefix: `${PREFIX}${key}_`, tools };
};

// Each server remote (Streamable HTTP, SSE its fallback), the bearer as a header, and OAuth off: a bearer the door
// refuses is an error to read, never a sign-in flow started from a headless server. `timeout` is how long OpenCode
// waits on one call, so a browser server's long bound carries over.
export const mcpServersOf = (mounts: OpenCodeMounts): OpenCodeMcpServer[] =>
    mounts.tools.map((tool) => ({
        name: `${mounts.prefix}${tool.name}`,
        config: {
            type: "remote",
            url: tool.url,
            ...opt("headers", tool.token === undefined ? undefined : { Authorization: `Bearer ${tool.token}` }),
            oauth: false,
            ...opt("timeout", tool.timeoutMs),
        },
    }));

// A prompt's tool switches, by tool key or wildcard pattern.
type PromptTools = NonNullable<NonNullable<SessionPromptAsyncData["body"]>["tools"]>;

// The prompt's `tools` map, which OpenCode keeps as the session's own rules: every mounted server hidden, then this
// conversation's shown (the later rule wins). Sent even by a turn that mounts nothing, so it never sees another's. A
// subagent's session inherits only the hiding (OpenCode's task tool carries a parent's deny rules alone), so OpenCode's
// own subagents run without these tools.
export const visibleToolsOf = (mounts: OpenCodeMounts): PromptTools => {
    const rules: PromptTools = { [`${PREFIX}*`]: false };
    if (mounts.tools.length > 0) {
        rules[`${mounts.prefix}*`] = true;
    }
    return rules;
};

// A mounted tool's key as the rest of the daemon spells an MCP call, `mcp__<server>__<tool>`, so its card reads the way
// Claude's and Cursor's do (a browser call as "Browser navigate"); any other name passes through as it came.
export const mcpToolNameOf = (mounts: OpenCodeMounts): ((raw: string) => string) => {
    // Longest first, so a server whose name extends another's is not read as the shorter one.
    const servers = mounts.tools.map((tool) => ({ name: tool.name, key: `${sanitized(tool.name)}_` })).toSorted((a, b) => b.key.length - a.key.length);
    return (raw) => {
        if (!raw.startsWith(mounts.prefix)) {
            return raw;
        }
        const rest = raw.slice(mounts.prefix.length);
        const server = servers.find((entry) => rest.startsWith(entry.key));
        return server === undefined ? raw : `mcp__${server.name}__${rest.slice(server.key.length)}`;
    };
};

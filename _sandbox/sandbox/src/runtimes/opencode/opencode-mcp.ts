import { createHash, randomBytes } from "node:crypto";
import type { McpAddInput, PermissionRule } from "@opencode/client";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import { opt } from "../../opt.js";

// A turn's MCP servers on the one shared `opencode serve`: the same remote list Codex and ACP agents take (the daemon's
// MCP door's browsers, machines and extension tools, and the mcp-kind cards), each server carrying the turn's bearer.
// OpenCode keeps MCP servers per directory rather than per session, and offers every session there every server's
// tools, while two conversations often share one directory. So a conversation's servers are mounted under names of
// its own, `intentic_<key>_<server>`, and every session's own rules show it those and deny it everyone else's (a denied
// action's tool is not offered to the model). A tool's key is OpenCode's own spelling, `<server>_<tool>`, which is
// also the permission action its calls are checked as.

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

// A remote server's config as OpenCode's `mcp.add` takes it.
export type McpRemoteConfig = Extract<McpAddInput["config"], { readonly type: "remote" }>;

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
// refuses is an error to read, never a sign-in flow started from a headless server (OpenCode 2 tries OAuth on a remote
// server unless told not to). Code mode off: OpenCode 2 would otherwise fold every tool into one `execute` runner the
// model scripts against, which would lose the per-tool cards and the per-tool rules below. `execution` is how long
// OpenCode waits on one call, so a browser server's long bound carries over.
export const mcpServersOf = (mounts: OpenCodeMounts): OpenCodeMcpServer[] =>
    mounts.tools.map((tool) => ({
        name: `${mounts.prefix}${tool.name}`,
        config: {
            type: "remote",
            url: tool.url,
            ...opt("headers", tool.token === undefined ? undefined : { Authorization: `Bearer ${tool.token}` }),
            oauth: false,
            codemode: false,
            ...opt("timeout", tool.timeoutMs === undefined ? undefined : { execution: tool.timeoutMs }),
        },
    }));

// The session's own permission rules, which OpenCode applies after the server's (the last match wins): every mounted
// server denied, then this conversation's allowed. Set even on a turn that mounts nothing, so it never sees another's.
export const sessionToolRules = (mounts: OpenCodeMounts): PermissionRule[] => [
    { action: `${PREFIX}*`, resource: "*", effect: "deny" },
    ...(mounts.tools.length > 0 ? [{ action: `${mounts.prefix}*`, resource: "*", effect: "allow" } as const] : []),
];

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

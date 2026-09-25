import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// The one way an extension gives the agent tools: an MCP server the daemon mounts into every turn at its own door
// (`/mcp/<name>`), whichever runtime serves the turn. A plugin's `.mcp.json` reached only Claude Code and spawned a
// process per session; this is served once, for every session.

// A path inside the extension's namespace or on a process's port: segments of [a-z0-9-], each starting alphanumeric,
// joined by single slashes, with none leading or trailing. The regex says all of it, so the authoring schema does too.
export const TOOL_PATH = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

export const ToolsContributionSchema = z
    .object({
        perCard: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]*$/)
            .optional()
            .describe(
                "The id of one of this extension's `cli` capability cards. Every turn granted a card of that kind gets one server named by the card's id, handed that card's settings (secrets included) with each call. Absent ⇒ one server for the extension, named by its `name`, in every turn while the extension is enabled.",
            ),
        process: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]*$/)
            .optional()
            .describe(
                'A process from `contributes.processes`, declared with `port: "auto"`, that answers MCP over Streamable HTTP at `path` on its port. Absent ⇒ your `server` bundle serves the tools.',
            ),
        path: z
            .string()
            .regex(TOOL_PATH)
            .optional()
            .describe(
                "Where the MCP endpoint answers, without a leading or trailing slash: on the process's port, or in your backend's own namespace when your `server` bundle speaks MCP itself. Absent with no `process` ⇒ the host serves what `api.tools.serve` returns, which is what you want: the host owns the transport, the deadlines and the card lookup. With `perCard`, a request arrives at `<path>/<card id>`.",
            ),
    })
    .meta({
        effect: "mcp",
        mintsServer: true,
        power: { key: "tools${perCard?-${perCard}:}", sentence: 'gives the agent MCP tools${perCard?, one server for each "${perCard}" card:}' },
    });
export type ToolsContribution = z.infer<typeof ToolsContributionSchema>;

export const toolsPoint = {
    name: "tools",
    description:
        "Tools for the agent, as an MCP server the daemon mounts into every turn and every runtime (Claude Code, Codex, Cursor, ACP agents). Serve them from your `server` bundle with `api.tools.serve((card) => [...])`, or from a declared process's port. Replaces an agent plugin's `.mcp.json`, which only Claude Code read.",
    schema: ToolsContributionSchema,
} as const satisfies ContributionPoint;

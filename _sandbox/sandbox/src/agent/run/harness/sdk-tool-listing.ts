import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { recordToolSchemas, type ToolListing } from "../../../logs/tool-schemas-log.js";

// What a Claude Code turn's in-process SDK servers (ui, subagents, watch, diagnostics…) put in its context, for the
// tool-schemas record (logs/tool-schemas-log.ts). They never pass the daemon's MCP door, which records every other
// server's listing, so they are read here off the live McpServer: its registered tools, each schema converted the way
// the server itself answers tools/list. `_registeredTools` is private to McpServer, hence the narrow read below.

const Registered = z.record(
    z.string(),
    z.looseObject({
        description: z.string().optional(),
        // McpServer stores each tool's input as a zod (v4) schema.
        inputSchema: z.custom<z.ZodType>((value) => value instanceof Object && "_zod" in value).optional(),
        enabled: z.boolean().optional(),
    }),
);

const InstanceTools = z.looseObject({ _registeredTools: Registered });

// A schema the converter cannot read is counted as its description alone: the record is an estimate, not a gate.
const jsonSchemaOf = (schema: z.ZodType | undefined): z.core.JSONSchema.BaseSchema | undefined => {
    if (schema === undefined) {
        return { type: "object" };
    }
    try {
        return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    } catch {
        // allow(silent-catch): a schema the converter cannot read is counted by its description alone (above).
        return undefined;
    }
};

const listingOf = (config: McpServerConfig): ToolListing | undefined => {
    if (config.type !== "sdk" || !("instance" in config)) {
        return undefined;
    }
    const parsed = InstanceTools.safeParse(config.instance);
    if (!parsed.success) {
        return undefined;
    }
    const tools = Object.entries(parsed.data["_registeredTools"])
        .filter(([, tool]) => tool.enabled !== false)
        .map(([name, tool]) => ({ name, description: tool.description, inputSchema: jsonSchemaOf(tool.inputSchema) }));
    return { tools };
};

/** Records each in-process server's tool listing; HTTP servers are recorded by the door when the CLI lists them. */
export const recordSdkToolSchemas = async (logsDir: string | undefined, conversationId: string | undefined, servers: Record<string, McpServerConfig>): Promise<void> => {
    if (logsDir === undefined) {
        return;
    }
    for (const [server, config] of Object.entries(servers)) {
        const listing = listingOf(config);
        if (listing !== undefined) {
            await recordToolSchemas(logsDir, { server, kind: "sdk", conversationId, listing });
        }
    }
};

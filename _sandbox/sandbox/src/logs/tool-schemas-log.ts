import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { undefinedIfMissing } from "@intentic/base/errors";
import { estimateTokens } from "@intentic/base/format";
import { logsRoot } from "../seams/logs-root.js";
import { opt } from "../opt.js";

/* WHAT EACH MCP SERVER'S TOOL DEFINITIONS COST A TURN (historyRoot/logs/tool-schemas.jsonl).

   Every tool a turn mounts arrives in the model's context as its name, description and input schema, before the user
   has typed anything. One line per server per listing: the daemon's MCP door writes one when a runtime lists a mounted
   server's tools (agent/tools/turn-mounts.routes.ts), and a Claude Code turn writes one for each in-process SDK server
   it hands the CLI (agent/run/harness/claude-code-runner.ts). `diagnostics tools` reads them back as the mount set of a
   conversation's latest turn, heaviest server first.

   The cost is an estimate: the serialized JSON of {name, description, inputSchema} per tool, in characters and in
   tokens by @intentic/base's estimateTokens (no tokenizer runs here; four characters a token was a fifth off on JSON,
   text/tokens.ts has the numbers). Rows written before 2026-11-26 carry chars/4. Whether those tokens reach the
   context depends on the runtime: a Claude Code turn with tool search defers MCP schemas behind ToolSearch and pays only
   for the names until one is loaded, every other runtime pays for every schema on every request. */

const TOOL_SCHEMAS_FILE = "tool-schemas.jsonl";

// The heaviest tools a line names, so a fat description can be found without listing the server again.
const HEAVIEST_KEPT = 3;

export interface ToolSchemaCost {
    readonly tools: number;
    readonly chars: number;
    readonly tokens: number;
    readonly heaviest: { readonly name: string; readonly chars: number }[];
}

const ListedTool = z.looseObject({ name: z.string(), description: z.string().optional(), inputSchema: z.unknown().optional() });

/** A tools/list result as the cost reads it: each tool's name, description and input schema; a malformed tool is dropped. */
export const ToolListingSchema = z.looseObject({
    tools: z.array(z.unknown()).transform((tools) => tools.flatMap((raw) => {
        const tool = ListedTool.safeParse(raw);
        return tool.success ? [tool.data] : [];
    })),
});
export type ToolListing = z.infer<typeof ToolListingSchema>;

/** What one tools/list result costs. */
export const schemaCostOf = (listing: ToolListing): ToolSchemaCost => {
    const serialized = listing.tools.map(({ name, description, inputSchema }) => ({ name, json: JSON.stringify({ name, description, inputSchema }) }));
    const sized = serialized.map(({ name, json }) => ({ name, chars: json.length }));
    return {
        tools: sized.length,
        chars: sized.reduce((sum, tool) => sum + tool.chars, 0),
        tokens: serialized.reduce((sum, tool) => sum + estimateTokens(tool.json), 0),
        heaviest: sized.toSorted((a, b) => b.chars - a.chars).slice(0, HEAVIEST_KEPT),
    };
};

const ToolSchemaLine = z.object({
    at: z.number(),
    conversationId: z.string().optional(),
    server: z.string(),
    // The mount's target kind (device, browser, daemon, …), or `sdk` for a Claude turn's in-process server.
    kind: z.string(),
    tools: z.number(),
    chars: z.number(),
    tokens: z.number(),
    heaviest: z.array(z.object({ name: z.string(), chars: z.number() })),
});
export type ToolSchemaLine = z.infer<typeof ToolSchemaLine>;

/** Appends one server's listing cost to the file in `logsDir` (historyRoot/logs). */
export const recordToolSchemas = async (
    logsDir: string,
    entry: { readonly conversationId: string | undefined; readonly server: string; readonly kind: string; readonly listing: ToolListing },
    now: number = Date.now(),
): Promise<void> => {
    if (logsDir === "") {
        return;
    }
    const line: ToolSchemaLine = { at: now, ...opt("conversationId", entry.conversationId), server: entry.server, kind: entry.kind, ...schemaCostOf(entry.listing) };
    await mkdir(logsDir, { recursive: true });
    await appendFile(join(logsDir, TOOL_SCHEMAS_FILE), `${JSON.stringify(line)}\n`);
};

const readLines = async (historyRoot: string): Promise<ToolSchemaLine[]> => {
    const raw = (await readFile(join(logsRoot(historyRoot), TOOL_SCHEMAS_FILE), "utf8").catch(undefinedIfMissing)) ?? "";
    return raw.split("\n").flatMap((text) => {
        if (text.trim() === "") {
            return [];
        }
        try {
            const parsed = ToolSchemaLine.safeParse(JSON.parse(text));
            return parsed.success ? [parsed.data] : [];
        } catch {
            // allow(silent-catch): a line a killed writer cut short is skipped, as every reader of an append-only log does.
            return [];
        }
    });
};

// Listings of one turn arrive within seconds of each other (the runtime lists every server as it starts); a server
// listed again later in the same conversation is a later turn, which replaces what it said before.
const ONE_TURN_MS = 10 * 60_000;

/** The latest mount set of one conversation: the newest listing of each server, within one turn of the newest. */
const latestMountSet = (lines: readonly ToolSchemaLine[], conversationId: string): ToolSchemaLine[] => {
    const own = lines.filter((line) => line.conversationId === conversationId);
    const newest = Math.max(...own.map((line) => line.at));
    const byServer = new Map<string, ToolSchemaLine>();
    for (const line of own) {
        if (line.at < newest - ONE_TURN_MS) {
            continue;
        }
        const seen = byServer.get(line.server);
        if (seen === undefined || seen.at < line.at) {
            byServer.set(line.server, line);
        }
    }
    return [...byServer.values()].toSorted((a, b) => b.tokens - a.tokens);
};

const thousands = (n: number): string => n.toLocaleString("en-US");

const renderSet = (set: readonly ToolSchemaLine[], conversationId: string): string => {
    const total = set.reduce((sum, line) => ({ tools: sum.tools + line.tools, chars: sum.chars + line.chars, tokens: sum.tokens + line.tokens }), {
        tools: 0,
        chars: 0,
        tokens: 0,
    });
    const when = new Date(Math.max(...set.map((line) => line.at))).toISOString();
    return [
        `Tool schemas by server for ${conversationId}'s latest turn (listed ${when}): ${set.length} servers, ${total.tools} tools, ` +
            `${thousands(total.chars)} chars, ~${thousands(total.tokens)} tokens (estimated, no tokenizer).`,
        "",
        ...set.map(
            (line) =>
                `${line.server} (${line.kind}): ${line.tools} tools, ${thousands(line.chars)} chars, ~${thousands(line.tokens)} tokens; heaviest ${ 
                line.heaviest.map((tool) => `${tool.name} ${thousands(tool.chars)}`).join(", ")}`,
        ),
    ].join("\n");
};

/** The `tools` diagnostics answer: one conversation's latest mount set, or the newest conversation's when none is named. */
export const toolSchemasAnswer = async (historyRoot: string, ask: { readonly conversationId?: string | undefined }): Promise<string> => {
    const lines = await readLines(historyRoot);
    const named = ask.conversationId ?? lines.findLast((line) => line.conversationId !== undefined)?.conversationId;
    const set = named === undefined ? [] : latestMountSet(lines, named);
    if (named === undefined || set.length === 0) {
        return (
            `No tool listings recorded${named === undefined ? "" : ` for ${named}`} in ${TOOL_SCHEMAS_FILE}. A turn records one per server ` +
            "as its runtime lists the tools it was given; a conversation that has not run a turn since this was added has none."
        );
    }
    return renderSet(set, named);
};

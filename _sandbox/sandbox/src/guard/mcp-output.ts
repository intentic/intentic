import { z } from "zod";
import type { PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { cleanToolText, parseCleaners, secretValues } from "@intentic/output-cleaners/cleaners";
import { retainIn } from "@intentic/output-cleaners/filter";

// Applied only to a new result at the hook/door boundary. Never walk or rewrite the session's history.
export interface McpOutputOptions {
    readonly spec?: string | undefined;
    readonly holdout?: number | undefined;
    readonly conversationId?: string | undefined;
    readonly logsDir: string;
    readonly name?: () => string;
}

export const mcpHeldOut = (options: McpOutputOptions): boolean => {
    // Stable across runtimes, turns and tools of a conversation; no per-block coin tosses.
    const bucket =
        createHash("sha256")
            .update(options.conversationId ?? "anonymous")
            .digest()
            .readUInt32BE(0) / 0x1_0000_0000;
    return bucket < (options.holdout ?? 0);
};

export const retainToolText = (text: string, options: McpOutputOptions): string | undefined => {
    try {
        return retainIn(
            join(options.logsDir, "raw-output"),
            `mcp-${options.name?.() ?? randomUUID()}.log`,
            secretValues(),
            Number.POSITIVE_INFINITY,
        )(text);
    } catch {
        // allow(silent-catch): if masking inputs cannot be loaded, do not save an unchecked copy or lose the report.
        return undefined;
    }
};

const cappedText = (text: string, tool: string, options: McpOutputOptions): string => {
    const snapshot = /browser_(?:snapshot|find)$/.test(tool) || /\[ref=[^\]\n]+\]/.test(text);
    const threshold = snapshot ? 49_152 : 16_384;
    if (text.length <= threshold) {
        return text;
    }
    const heldOut = mcpHeldOut(options);
    let out = text;
    if (!heldOut) {
        const limits = snapshot ? { chars: 32_000, lines: 400, head: 150, tail: 200 } : { chars: 12_000, lines: 100, head: 30, tail: 50 };
        const cleaned = cleanToolText(text, { ...limits, enabled: parseCleaners(options.spec) });
        if (cleaned.length < text.length) {
            const file = retainToolText(text, options);
            // A failed save must never leave the agent with an irretrievable, shortened result.
            if (file !== undefined) {
                out = `${cleaned}\n--- MCP output: ${text.length - cleaned.length} chars cut · full: retrieve-output ${file} [pattern]${snapshot ? " · browser_find can locate omitted elements and refs" : ""}`;
            }
        }
    }
    try {
        mkdirSync(options.logsDir, { recursive: true });
        appendFileSync(
            join(options.logsDir, "filter-stats.jsonl"),
            `${JSON.stringify({ ts: Date.now(), command: tool, tool, rawBytes: text.length, emittedBytes: out.length, heldOut, cleaners: ["mcp"], matched: ["mcp"], stageBytes: { mcp: text.length - out.length } })}\n`,
        );
    } catch {
        // allow(silent-catch): telemetry cannot cost a tool's result.
    }
    return out;
};

// The SDK and the RPC door deliberately leave tool results opaque; parse only the MCP text envelope we own.
export type ToolOutput = PostToolUseHookInput["tool_response"];
const ResultSchema = z.looseObject({ content: z.array(z.unknown()) });
const TextPartSchema = z.looseObject({ type: z.literal("text"), text: z.string() });

export const cleanMcpResult = (tool: string, result: ToolOutput, options?: McpOutputOptions): ToolOutput => {
    if (
        options === undefined ||
        options.spec === "off" ||
        !tool.startsWith("mcp__") ||
        /^mcp__(?:ui|watch|code|secrets)__/.test(tool) ||
        tool === "mcp__subagents__wait"
    ) {
        return result;
    }
    try {
        const parsed = ResultSchema.safeParse(result);
        if (!parsed.success) {
            return result;
        }
        const parts = parsed.data.content;
        const content = parts.map((part) => {
            const item = TextPartSchema.safeParse(part);
            if (!item.success) {
                return part;
            }
            const text = cappedText(item.data.text, tool, options);
            return text === item.data.text ? part : { ...item.data, text };
        });
        return content.some((part, index) => part !== parts[index]) ? { ...parsed.data, content } : result;
    } catch {
        // allow(silent-catch): a cleaner failing must not fail the underlying tool call.
        return result;
    }
};

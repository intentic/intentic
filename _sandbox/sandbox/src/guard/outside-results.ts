import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { classifyCommand } from "@intentic/sandbox-contract";
import { JS_TOOL_NAME } from "../execution/js-tool.js";
import { wrapOutsideContent } from "@intentic/base/outside-text";

// Wraps tool results that pull outside content into the turn mid-run, the counterpart to automations/scheduler.ts's
// turn-birth wrap. Runs on PostToolUse, which fires for every tool including ones not yet written, so the default is
// wrap and exceptions are named explicitly. Wraps only the fields that carry content, never the whole result object.

// Daemon's own control servers, the exceptions to wrap-by-default: none carries content from outside this container.
// Browser servers are deliberately absent. Pinned by the conformance test in outside-results.test.ts.
export const INTERNAL_SERVERS: ReadonlySet<string> = new Set([
    // agent/agent.ts mounts these two directly.
    "ui", // AskUserQuestion
    "accounts", // browser/accounts-tools.ts: the roster and the credential typists
    // agent/turn-plan.ts sdkServers.
    "secrets", // browser/secrets-tools.ts: types a stored value into a focused field
    "hashline", // hash-anchored Edit/Write replacements
    "subagents", // the `wait` park
    "watch", // condition watches
    "deps", // dependency readiness
    // Internal for the server itself; the pane output it carries back wraps separately, at the tool.
    "terminal",
    // Same as Bash: the agent's own in-container script; wrapped only when it fetches, via its own branch.
    "code",
]);

// `mcp__<server>__<tool>`, the SDK's naming for an MCP tool; anything else is a native tool.
const MCP_TOOL = /^mcp__([^_](?:[^_]|_[^_])*)__/;

export const mcpServerOf = (toolName: string): string | undefined => MCP_TOOL.exec(toolName)?.[1];

// What this tool result should be wrapped as, the envelope's source label, or undefined to leave it alone. Pure, so the
// whole matrix is a table test.
export const outsideSourceOf = (toolName: string, toolInput: unknown): string | undefined => {
    if (toolName === "WebFetch") {
        return "web";
    }
    if (toolName === "WebSearch") {
        return "web-search";
    }
    if (toolName === "Bash") {
        const command = (toolInput as { command?: unknown } | null)?.command;
        if (typeof command !== "string") {
            return undefined;
        }
        // Same classifier the command gate runs before the command; loopback is excluded by the class itself.
        return classifyCommand(command, { locus: "sandbox" }).includes("network.outbound") ? "shell-fetch" : undefined;
    }
    // Same rule as Bash, checked before the server fallback since the `code` server is INTERNAL.
    if (toolName === JS_TOOL_NAME) {
        const code = (toolInput as { code?: unknown } | null)?.code;
        if (typeof code !== "string") {
            return undefined;
        }
        return classifyCommand(code, { locus: "sandbox" }).includes("network.outbound") ? "code-fetch" : undefined;
    }
    const server = mcpServerOf(toolName);
    if (server === undefined || INTERNAL_SERVERS.has(server)) {
        return undefined;
    }
    return server;
};

// Wraps a string field in place; anything that is not a non-empty string is left alone.
const sealed = (value: unknown, source: string): unknown =>
    typeof value === "string" && value !== "" ? wrapOutsideContent(value, { source }) : value;

// Applies the envelope to a tool result's content-bearing parts. Returns the same reference when nothing changed, the
// convention agent-redaction.ts maskDeep also uses.
export const sealResult = (toolName: string, result: unknown, source: string): unknown => {
    if (typeof result === "string") {
        // Some tools answer with a bare string; the whole of it is the content.
        return sealed(result, source);
    }
    if (result === null || typeof result !== "object") {
        return result;
    }
    const record = result as Record<string, unknown>;
    // MCP result shape `{ content: [{ type, text }] }`; only text parts are wrapped, not image data.
    if (Array.isArray(record["content"])) {
        const parts = record["content"] as unknown[];
        const wrapped = parts.map((part) => {
            if (part === null || typeof part !== "object") {
                return part;
            }
            const item = part as Record<string, unknown>;
            if (item["type"] !== "text" || typeof item["text"] !== "string") {
                return part;
            }
            const text = sealed(item["text"], source);
            return text === item["text"] ? part : { ...item, text };
        });
        return wrapped.some((part, index) => part !== parts[index]) ? { ...record, content: wrapped } : result;
    }
    // Native tools' content fields; Bash's stderr wraps alongside stdout, an error is still its words.
    const FIELDS: Readonly<Record<string, readonly string[]>> = {
        Bash: ["stdout", "stderr"],
        WebFetch: ["result"],
        WebSearch: ["results"],
    };
    const fields = FIELDS[toolName];
    if (fields === undefined) {
        return result;
    }
    const entries = fields.flatMap((field) => {
        if (!(field in record)) {
            return [];
        }
        // WebSearch answers with an array of hits and commentary strings; wrap the strings in it.
        const current = record[field];
        const next = Array.isArray(current) ? current.map((item) => sealed(item, source)) : sealed(current, source);
        const changed = Array.isArray(current) ? (next as unknown[]).some((item, index) => item !== current[index]) : next !== current;
        return changed ? [[field, next] as const] : [];
    });
    return entries.length === 0 ? result : { ...record, ...Object.fromEntries(entries) };
};

// `onWrapped` marks the turn's taint bit (guard/turn-taint.ts), fired only when a result was actually rewritten, not
// merely eligible.
export const outsideResultHooks = (onWrapped: (source: string) => void): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PostToolUse: [
        {
            // No matcher: every tool, including ones nobody has written yet.
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PostToolUse") {
                        return {};
                    }
                    try {
                        const source = outsideSourceOf(input.tool_name, input.tool_input);
                        if (source === undefined) {
                            return {};
                        }
                        const wrapped = sealResult(input.tool_name, input.tool_response, source);
                        if (wrapped === input.tool_response) {
                            return {};
                        }
                        onWrapped(source);
                        return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: wrapped } };
                    } catch {
                        // An unexpected result shape is left alone rather than failing the tool call that produced it.
                        return {};
                    }
                },
            ],
        },
    ],
});

import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { classifyCommand } from "./command-classes.js";
import { wrapOutsideContent } from "./outside-content.js";

/* WRAPPING WHAT THE AGENT PULLS IN MID-TURN — the second seam, beside the one that wraps a stranger's message
 * at turn birth (automations/scheduler.ts). Same envelope, same reason; the difference is only that nobody
 * chose to start this turn, the agent reached for it.
 *
 * It rides the SAME hook event masking does (agent/agent-redaction.ts) and for the same reason: PostToolUse
 * fires for every tool the model calls, including the ones nobody has written yet, and `updatedToolOutput`
 * replaces the result before the model is shown it. A list of ingestion points maintained by hand is a list of
 * the ones somebody remembered — which is the gap this exists to close, so the default here is WRAP and the
 * exceptions are named.
 *
 * WHICH TOOLS. The rule is about where the BYTES came from, not who ran the tool:
 *
 *   · WebFetch / WebSearch      — the open internet, plainly.
 *   · every MCP server except the daemon's own control servers (INTERNAL below) — a user-configured server is
 *     somebody else's process answering with somebody else's data. Wrap-unless-allowlisted, so a server added
 *     tomorrow is wrapped by default and a new INTERNAL one has to be named (and the conformance test says so).
 *   · the browser servers, which are NOT in INTERNAL on purpose — Playwright is ours, the PAGE is the
 *     internet, and the whole point of a browser tool is to bring that page's text back.
 *   · Bash output, but only when the command reached OUT: the `network.outbound` class of the same classifier
 *     the command gate consults (guard/command-classes.ts), so `curl https://example.com` is wrapped, and `ls`
 *     — or a curl at loopback, which is this container talking to itself — is not.
 *
 * WHAT IS NOT WRAPPED, said plainly rather than left to be discovered:
 *   · Read/Grep/Glob of workspace files — the agent's own material. A hostile file in the workspace arrived
 *     through some other seam, and wrapping every file read would wrap the codebase.
 *   · shell output that fetched without looking like it (`git pull`, `gh issue view`) — the classifier is
 *     regex over shell text and carries the same honesty note as guard/command-classes.ts.
 *   · what a delegated CLI read inside its own context — its harness, its seams, not ours.
 *
 * The wrap is applied to the FIELDS that carry content, never to the whole result object: a tool's result is a
 * shape its caller parses (`stdout` for Bash, `result` for WebFetch, a content array for MCP), and stringifying
 * that into an envelope would break every reader downstream to make a point to one of them. Image and other
 * non-text parts ride through untouched.
 */

/* The daemon's OWN control servers — the exceptions to wrap-by-default. Every one of these is the daemon
 * talking to the agent about the turn itself: a question card, a park, a dependency probe, a file edit. None
 * carries content from outside this container, and wrapping them would tell the model its own platform is a
 * stranger. Browser servers are deliberately absent (see the header). Pinned by the conformance test in
 * outside-results.test.ts, so a new control server added without a decision here fails the suite. */
export const INTERNAL_SERVERS: ReadonlySet<string> = new Set([
    // agent/agent.ts mounts these two directly.
    "ui", // AskUserQuestion
    "accounts", // browser/accounts-tools.ts — the roster and the credential typists
    // agent/turn-plan.ts sdkServers.
    "secrets", // browser/secrets-tools.ts — types a stored value into a focused field
    "hashline", // hash-anchored Edit/Write replacements
    "subagents", // the `wait` park
    "watch", // condition watches
    "deps", // dependency readiness
]);

// `mcp__<server>__<tool>` — the SDK's naming for every MCP tool. Anything else is a native tool.
const MCP_TOOL = /^mcp__([^_](?:[^_]|_[^_])*)__/;

export const mcpServerOf = (toolName: string): string | undefined => MCP_TOOL.exec(toolName)?.[1];

/* What, if anything, this tool result should be wrapped as — the source label the envelope carries, or
 * undefined to leave the result alone. Pure, so the whole matrix is a table test. */
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
        // The same classifier the command gate runs BEFORE the command: if it reached the open internet, what
        // came back is the open internet's words. Loopback is excluded by the class itself.
        return classifyCommand(command).includes("network.outbound") ? "shell-fetch" : undefined;
    }
    const server = mcpServerOf(toolName);
    if (server === undefined || INTERNAL_SERVERS.has(server)) {
        return undefined;
    }
    return server;
};

// Wrap a string field in place, leaving anything that is not a non-empty string alone.
const sealed = (value: unknown, source: string): unknown =>
    typeof value === "string" && value !== "" ? wrapOutsideContent(value, { source }) : value;

/* Apply the envelope to the content-bearing parts of one tool result. Returns the SAME reference when nothing
 * changed, which is how the hook tells "unchanged" from "rewritten" without re-comparing a large result —
 * the same convention agent-redaction.ts maskDeep uses next door. */
export const sealResult = (toolName: string, result: unknown, source: string): unknown => {
    if (typeof result === "string") {
        // Some tools answer with a bare string; the whole of it is the content.
        return sealed(result, source);
    }
    if (result === null || typeof result !== "object") {
        return result;
    }
    const record = result as Record<string, unknown>;
    /* An MCP result: `{ content: [{ type: "text", text }, { type: "image", … }] }`. Only text parts are
     * wrapped — an image part's data is not prose and an envelope around a base64 blob helps nobody. */
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
    // The native tools whose content sits in a known field. Bash's stderr is wrapped alongside stdout — a
    // server's error body is as much its words as its output is.
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
        // WebSearch answers with an ARRAY of hits and commentary strings; wrap the strings in it.
        const current = record[field];
        const next = Array.isArray(current) ? current.map((item) => sealed(item, source)) : sealed(current, source);
        const changed = Array.isArray(current) ? (next as unknown[]).some((item, index) => item !== current[index]) : next !== current;
        return changed ? [[field, next] as const] : [];
    });
    return entries.length === 0 ? result : { ...record, ...Object.fromEntries(entries) };
};

/* The hook. `onWrapped` is how the turn learns it has taken content in from outside — the taint bit the
 * command gate reads (guard/turn-taint.ts). Fired only when a result was actually rewritten, so a turn that
 * merely HAS a browser is not tainted by owning one. */
export const outsideResultHooks = (onWrapped: (source: string) => void): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PostToolUse: [
        {
            // No matcher — every tool, including the ones nobody has written yet. See the header.
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
                        // A result shape this did not expect is a reason to leave it alone, never to fail the
                        // tool call that produced it — the same guard masking keeps next door.
                        return {};
                    }
                },
            ],
        },
    ],
});

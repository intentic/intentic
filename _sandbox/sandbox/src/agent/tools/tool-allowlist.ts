import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// A turn's tool list (TurnPolicy.allowedTools, an automation's `allowedTools`) as a boundary: a call to anything off it
// is refused before it runs. The contract calls the list "the real boundary" for a turn an outside message drives, and
// the SDK's own `allowedTools` is not one: it only spares the listed tools a permission prompt, and under
// bypassPermissions, where every unattended turn runs, nothing is prompted anyway. A runtime that cannot run a check
// before every call declares it (AgentCapabilities.toolAllowlist) and never starts a turn that carries a list.
// 2026-10-12: the list reached the Claude SDK only as `allowedTools`, so no runtime kept it; rejected.

// What one call is, as the list is checked against it: the tool's name and, for the shell, the command it would run.
export interface ToolCall {
    readonly name: string;
    readonly command?: string | undefined;
}

// The hashline tools stand in for the native file tools when the hashlineEdits setting is on: a list naming Read, Edit or
// Write means them too, since which spelling a turn gets is a setting the owner flipped and not a fact about the call.
const STANDS_FOR = new Map([
    ["mcp__hashline__read", "Read"],
    ["mcp__hashline__edit", "Edit"],
    ["mcp__hashline__write", "Write"],
]);

// A command that chains, pipes, substitutes or redirects is more than its first words, so no prefix vouches for it.
const COMPOUND = /[;&|`<>\n]|\$\(/;

// One list entry, as Claude's permission rules spell one: a tool name, a whole MCP server (`mcp__server` or
// `mcp__server__*`), or the shell narrowed to a command (`Bash(npm test)`) or a prefix (`Bash(git log:*)`). Any other
// narrowing (`Read(./src/**)`, `WebFetch(domain:x)`) is one this check cannot read, so it allows nothing: a list is a
// boundary, and an entry nobody can check must not widen it.
const allowsBy = (entry: string, call: ToolCall): boolean => {
    const name = STANDS_FOR.get(call.name) ?? call.name;
    const narrowed = /^([^()]+)\((.*)\)$/s.exec(entry.trim());
    if (narrowed === null) {
        const tool = entry.trim();
        if (tool === name) {
            return true;
        }
        const server = tool.endsWith("__*") ? tool.slice(0, -3) : tool;
        return server.startsWith("mcp__") && !server.slice("mcp__".length).includes("__") && name.startsWith(`${server}__`);
    }
    const [, tool, rule] = narrowed;
    if (tool?.trim() !== "Bash" || name !== "Bash" || call.command === undefined || rule === undefined) {
        return false;
    }
    const command = call.command.trim();
    if (rule.endsWith(":*")) {
        const prefix = rule.slice(0, -2).trim();
        return !COMPOUND.test(command) && (command === prefix || command.startsWith(`${prefix} `));
    }
    return command === rule.trim();
};

/** Whether the turn's list lets this call run. An empty list lets nothing run. */
export const toolAllowed = (list: readonly string[], call: ToolCall): boolean => list.some((entry) => allowsBy(entry, call));

/** What the agent reads when a call is refused: which list said no, and what to do instead of retrying. */
export const allowlistRefusal = (call: ToolCall, list: readonly string[]): string =>
    list.length === 0
        ? `${call.name} is not available in this turn: it was started with no tools at all. Answer in words.`
        : `${call.name}${call.name === "Bash" && call.command !== undefined ? ` (${call.command.slice(0, 80)})` : ""} is not on this turn's tool list (${list.join(", ")}). Do not retry it or look for another way to the same thing: use a listed tool, or say what you could not do.`;

// The shell's command, read off the tool's input; any other tool's input carries none.
const ShellInputSchema = z.object({ command: z.string() });

/** The Claude harness's check: a PreToolUse hook on every tool, which fires under bypassPermissions and for subagents. */
export const toolAllowlistHooks = (list: readonly string[]) =>
    ({
    PreToolUse: [
        {
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    const call = { name: input.tool_name, command: ShellInputSchema.safeParse(input.tool_input).data?.command };
                    if (toolAllowed(list, call)) {
                        return {};
                    }
                    return {
                        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: allowlistRefusal(call, list) },
                    };
                },
            ],
        },
    ],
}) satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;

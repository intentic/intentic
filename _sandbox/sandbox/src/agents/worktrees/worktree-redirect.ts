import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { type IsolationPlan, inWorktree } from "./isolation.js";

// When the worktree bind-mount cannot be built (no CAP_SYS_ADMIN), this rewrites absolute workspace-root paths into the
// conversation's worktree at the tool-call layer, silently; MAIN_MOUNT still allows a deliberate write to the main
// checkout. Covers only paths that arrive as tool input, not ones a subprocess computes itself.

// Regex-escapes a path for embedding in the command matcher below.
const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// Matches absolute root paths inside a shell command. The lookbehind refuses a root that is part of a longer path
// (letting MAIN_MOUNT through); the trailing class stops at the characters that end a path in shell.
const commandPaths = (root: string): RegExp => new RegExp(String.raw`(?<![\w./-])${escapeRegExp(root)}(?:/[^\s'"\`;:,)\]}]*)?`, "g");

// Detects heredoc delimiters; their bodies are data, not paths, and must stay unrewritten.
const HEREDOC_START = /<<-?\s*(["']?)([A-Za-z_][\w]*)\1/g;

// The [start, end) spans of every heredoc body in the command, in order.
const heredocSpans = (command: string): { start: number; end: number }[] => {
    const spans: { start: number; end: number }[] = [];
    for (const match of command.matchAll(HEREDOC_START)) {
        const word = match[2];
        if (word === undefined) {
            continue;
        }
        // Body: line after the delimiter to the line holding the word alone; unterminated protects the rest.
        const bodyStart = command.indexOf("\n", match.index + match[0].length);
        if (bodyStart === -1) {
            continue;
        }
        const terminator = new RegExp(String.raw`^[ \t]*${word}[ \t]*$`, "m");
        const rest = terminator.exec(command.slice(bodyStart));
        spans.push({ start: bodyStart, end: rest === null ? command.length : bodyStart + rest.index });
    }
    return spans;
};

// Rewrites every main-root path in a shell command, outside heredoc bodies. Shared by the Bash hook and the terminal
// wrapper.
export const redirectCommand = (command: string, plan: IsolationPlan): string => {
    const spans = heredocSpans(command);
    return command.replaceAll(commandPaths(plan.root), (match, ...rest) => {
        const at = rest.at(-2) as number;
        return spans.some((span) => at >= span.start && at < span.end) ? match : inWorktree(match, plan);
    });
};

// Path-taking tools and the field each uses; Read/search sit beside writers to avoid a half-isolated pair.
const PATH_FIELDS: Record<string, string> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    NotebookEdit: "notebook_path",
    Glob: "path",
    Grep: "path",
};

export const worktreeRedirectHooks = (plan: IsolationPlan): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PreToolUse: [
        {
            matcher: Object.keys(PATH_FIELDS).join("|"),
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    const field = PATH_FIELDS[input.tool_name];
                    if (field === undefined) {
                        return {};
                    }
                    const toolInput = input.tool_input as Record<string, unknown>;
                    const path = toolInput[field];
                    if (typeof path !== "string") {
                        return {};
                    }
                    const target = inWorktree(path, plan);
                    if (target === path) {
                        return {};
                    }
                    // No additionalContext: the swap gives the agent its own tree's contents without narrating it on
                    // every call.
                    return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, [field]: target } } };
                },
            ],
        },
    ],
});

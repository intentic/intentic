import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { heredocBodies } from "@intentic/sandbox-contract";
import { type IsolationPlan, inWorktree } from "./isolation.js";

// When the worktree bind-mount cannot be built (no CAP_SYS_ADMIN), this rewrites absolute workspace-root paths into the
// conversation's worktree at the tool-call layer, silently; MAIN_MOUNT still allows a deliberate write to the main
// checkout. Covers only paths that arrive as tool input, not ones a subprocess computes itself.

// Regex-escapes a path for embedding in the command matcher below.
const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// Matches absolute root paths inside a shell command. The lookbehind refuses a root that is part of a longer path
// (letting MAIN_MOUNT through); the trailing class stops at the characters that end a path in shell.
const commandPaths = (root: string): RegExp => new RegExp(String.raw`(?<![\w./-])${escapeRegExp(root)}(?:/[^\s'"\`;:,)\]}]*)?`, "g");

// Rewrites every main-root path in a shell command, outside heredoc bodies. Shared by the Bash hook and the terminal
// wrapper.
export const redirectCommand = (command: string, plan: IsolationPlan): string => {
    const spans = heredocBodies(command);
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

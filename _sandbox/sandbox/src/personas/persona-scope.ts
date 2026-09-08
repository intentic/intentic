import { isAbsolute, relative, resolve } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { TurnPersona } from "./personas.js";

// Enforces a persona's `folders` and `sandbox` scope as a PreToolUse hook, the point a path is a fact, not an
// intention; it doesn't stop a shell, which computes its own paths (that's what `shell` gates). Hooks fire under
// bypassPermissions, the only layer left for an unattended turn. Only paths inside the workspace are judged.

// Built-in tools that take a path as structured input, and the field each calls it.
const PATH_FIELDS: Record<string, string> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    NotebookEdit: "notebook_path",
    Glob: "path",
    Grep: "path",
};

// Tools that change a file; the `sandbox` switch gates editing config, not reading it.
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

// "Change the sandbox" as paths: config/automations, and the outbox served publicly; matched as prefixes.
const SANDBOX_PATHS = [".intentic", "public"];

// Is `target` inside `folder`, via `relative`, not a string prefix; `/work/app2` isn't inside `/work/app`.
const inside = (target: string, folder: string): boolean => {
    const rel = relative(folder, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export interface PersonaScope {
    // Turn's own root (worktree if isolated, else the workspace); card folders resolve against this.
    readonly cwd: string;
    // Workspace-relative folders the card allows. Empty ⇒ no folder limit (the whole workspace).
    readonly folders: readonly string[];
    // Whether this persona may change the sandbox's own configuration and its public outbox.
    readonly sandbox: boolean;
}

// Scope a persona asks for; undefined when it asks for nothing, so an unconfigured workspace pays for no hook.
export const personaScopeOf = (persona: TurnPersona, cwd: string): PersonaScope | undefined => {
    const folders = persona.workspace?.folders ?? [];
    if (folders.length === 0 && persona.powers.sandbox) {
        return undefined;
    }
    return { cwd, folders, sandbox: persona.powers.sandbox };
};

// Refusal reason worded for the agent to act on: naming the allowed folders turns a blind retry loop into either the
// right path or an honest "this needs more than I have".
const refusal = (scope: PersonaScope, sandboxPath: boolean): string =>
    sandboxPath
        ? `This persona may not change the sandbox's own configuration or its public outbox. If the task genuinely needs that, stop and say so rather than working around it.`
        : `This persona works inside ${scope.folders.join(", ")}, that path is outside it. If the task genuinely needs a file elsewhere in the workspace, stop and say so rather than working around it.`;

export const personaScopeHooks = (scope: PersonaScope): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
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
                    const path = (input.tool_input as Record<string, unknown>)[field];
                    // Absent path is the tool's own default (Glob/Grep search cwd, already in scope); nothing to judge.
                    if (typeof path !== "string") {
                        return {};
                    }
                    const target = resolve(scope.cwd, path);
                    // Outside the workspace entirely: not this setting's question.
                    if (!inside(target, scope.cwd)) {
                        return {};
                    }
                    const workspaceRelative = relative(scope.cwd, target);
                    const sandboxPath =
                        !scope.sandbox &&
                        WRITE_TOOLS.has(input.tool_name) &&
                        SANDBOX_PATHS.some((prefix) => inside(target, resolve(scope.cwd, prefix)));
                    const outsideFolders = scope.folders.length > 0 && !scope.folders.some((folder) => inside(target, resolve(scope.cwd, folder)));
                    if (!sandboxPath && !outsideFolders) {
                        return {};
                    }
                    return {
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            permissionDecision: "deny",
                            permissionDecisionReason: `${workspaceRelative}: ${refusal(scope, sandboxPath)}`,
                        },
                    };
                },
            ],
        },
    ],
});

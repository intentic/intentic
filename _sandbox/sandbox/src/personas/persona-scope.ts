import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { type Fence, fenceAllows, isSandboxPath } from "@intentic/sandbox-contract/policy/fence-paths";
import { EDIT_TOOL_NAMES, editedPath } from "../rules/edit-tools.js";
import type { TurnPersona } from "./personas.js";

// Enforces a turn's fence and its `sandbox` scope as a PreToolUse hook, the point a path is a fact, not an
// intention; it doesn't stop a shell, which computes its own paths (that's what `shell` gates). Hooks fire under
// bypassPermissions, the only layer left for an unattended turn. Only paths inside the workspace are judged.

// Tools that read a path the fence still bounds, beyond the editing ones. The hashline read is here because with the
// hashlineEdits setting on it is how a turn reads for an edit; leaving it out would let a fenced persona read anywhere.
const READ_TOOL_NAMES = ["Read", "Glob", "Grep", "mcp__hashline__read"] as const;

// Tools that change a file; the `sandbox` switch gates editing config, not reading it. One list with every other hook
// that listens for an edit (rules/edit-tools.ts), so a tool added there is fenced here without a second edit.
const WRITE_TOOLS: ReadonlySet<string> = new Set(EDIT_TOOL_NAMES);

const FENCED_TOOLS = [...READ_TOOL_NAMES, ...EDIT_TOOL_NAMES];

// The workspace-relative spelling of a target, or undefined when it lies outside the workspace. Judged by segment: a
// first segment of `..` climbs out, while `..stash` is an ordinary folder inside, which a string prefix would misread.
const workspaceRelative = (cwd: string, target: string): string | undefined => {
    const rel = relative(cwd, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return undefined;
    }
    return rel.split(sep).join("/");
};

export interface PersonaScope {
    // Turn's own root (worktree if isolated, else the workspace); fence folders resolve against this.
    readonly cwd: string;
    // The turn's resolved fence: the persona's own folders already narrowed by the one its starter holds. Undefined is the
    // whole workspace; an EMPTY list is a real fence that admits nothing, which is why this is not a plain array.
    readonly fence: Fence;
    // Whether this persona may change the sandbox's own configuration and its public outbox.
    readonly sandbox: boolean;
}

// Scope a persona asks for; undefined when it asks for nothing, so an unconfigured workspace pays for no hook.
// A conversation a fenced person opened is bounded here even when its persona names no folder at all.
export const personaScopeOf = (persona: TurnPersona, cwd: string): PersonaScope | undefined => {
    if (persona.fence === undefined && persona.powers.sandbox) {
        return undefined;
    }
    return { cwd, fence: persona.fence, sandbox: persona.powers.sandbox };
};

// Refusal reason worded for the agent to act on: naming the allowed folders turns a blind retry loop into either the
// right path or an honest "this needs more than I have". A fence admitting nothing says so rather than naming an
// empty list, which would read as a bug in the message.
const refusal = (scope: PersonaScope, sandboxPath: boolean): string => {
    if (sandboxPath) {
        return `This persona may not change the sandbox's own configuration or its public outbox. If the task genuinely needs that, stop and say so rather than working around it.`;
    }
    const where = (scope.fence ?? []).length === 0 ? `no folder of this workspace` : `inside ${(scope.fence ?? []).join(", ")}`;
    return `This persona works ${where}, that path is outside it. If the task genuinely needs a file elsewhere in the workspace, stop and say so rather than working around it.`;
};

export const personaScopeHooks = (scope: PersonaScope): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PreToolUse: [
        {
            matcher: FENCED_TOOLS.join("|"),
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    if (!(FENCED_TOOLS as readonly string[]).includes(input.tool_name)) {
                        return {};
                    }
                    const path = editedPath(input.tool_input);
                    // Absent path is the tool's own default (Glob/Grep search cwd, already in scope); nothing to judge.
                    if (path === undefined) {
                        return {};
                    }
                    const rel = workspaceRelative(scope.cwd, resolve(scope.cwd, path));
                    // Outside the workspace entirely: not this setting's question.
                    if (rel === undefined) {
                        return {};
                    }
                    const sandboxPath = !scope.sandbox && WRITE_TOOLS.has(input.tool_name) && isSandboxPath(rel);
                    const outsideFolders = !fenceAllows(scope.fence, rel);
                    if (!sandboxPath && !outsideFolders) {
                        return {};
                    }
                    return {
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            permissionDecision: "deny",
                            permissionDecisionReason: `${rel}: ${refusal(scope, sandboxPath)}`,
                        },
                    };
                },
            ],
        },
    ],
});

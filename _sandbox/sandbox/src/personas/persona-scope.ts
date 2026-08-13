import { isAbsolute, relative, resolve } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { TurnPersona } from "./personas.js";

/* WHERE A PERSONA'S FILE TOOLS MAY POINT — the `folders` half of a card's workspace scope, and the `sandbox`
 * switch, enforced at the one moment a path is a fact rather than an intention.
 *
 * A REFUSAL, NOT A WALL, AND THE CARD SAYS SO WHERE IT IS SET. This is a PreToolUse hook, so it sees exactly
 * what worktree-redirect.ts sees: the paths that arrive as structured tool input. It stops the whole class of
 * mistake these limits are bought for — a chore wandering out of its repo, a Doorbell-driven turn reading a
 * file the visitor named, an instruction smuggled into a support question — and it does not stop a shell, which
 * computes its own paths and never shows them to a hook. That is why the shelf above it is `shell`: switching
 * that off is what turns this from a strong default into a fence, and PersonaPowersSchema says the same thing
 * one layer up.
 *
 * Hooks fire even under bypassPermissions and for subagents too, which is what makes this hold for the turns it
 * exists for: an unattended wake has no permission cards, so a hook is the only layer left between a prompt a
 * stranger shaped and the file it names.
 *
 * ONLY PATHS INSIDE THE WORKSPACE ARE JUDGED. The setting is spelled in workspace-relative folders and means
 * what it says; a path somewhere else on the container (/tmp, an image-baked tool's own config) is a different
 * question, answered by the container itself. Judging those here would refuse an attachment the user just
 * uploaded and read as a broken tool. */

// The built-in tools that take a path as STRUCTURED input, and the field each calls it — the same enumeration
// worktree-redirect.ts makes, for the same reason: these are the calls a check can serve exactly.
const PATH_FIELDS: Record<string, string> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    NotebookEdit: "notebook_path",
    Glob: "path",
    Grep: "path",
};

// The tools that CHANGE a file. The `sandbox` switch is about editing the sandbox's own configuration, not
// about reading it — an agent reads .intentic to answer questions about itself all day, and refusing that
// would break far more than it protects.
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/* What "change the sandbox" means as paths: the directory holding its settings, manifests and automations, and
 * the outbox whose every file is served on the public internet to anyone with the link. Both are workspace
 * files an ordinary edit could reach, and neither is something a bounded persona should reach by accident.
 *
 * Workspace-relative and matched as prefixes, so a nested path under either is covered too. */
const SANDBOX_PATHS = [".intentic", "public"];

// Is `target` inside `folder`, both absolute? Compared through `relative` rather than by string prefix, so
// `/work/app2` does not read as being inside `/work/app`.
const inside = (target: string, folder: string): boolean => {
    const rel = relative(folder, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export interface PersonaScope {
    // The turn's own root — the worktree for an isolated turn, the workspace for a main-tree one. Every
    // workspace-relative folder on the card resolves against this, so a scoped persona means the same folders
    // in its own copy as it does in the shared tree.
    readonly cwd: string;
    // Workspace-relative folders the card allows. Empty ⇒ no folder limit (the whole workspace).
    readonly folders: readonly string[];
    // Whether this persona may change the sandbox's own configuration and its public outbox.
    readonly sandbox: boolean;
}

// The scope a persona asks for, or undefined when it asks for nothing — which is what keeps a workspace that
// has never set one from paying for a hook at all.
export const personaScopeOf = (persona: TurnPersona, cwd: string): PersonaScope | undefined => {
    const folders = persona.workspace?.folders ?? [];
    if (folders.length === 0 && persona.powers.sandbox) {
        return undefined;
    }
    return { cwd, folders, sandbox: persona.powers.sandbox };
};

/* Why a path is refused, in the words the agent needs to do something useful about it. Naming the folders it
 * MAY use is the load-bearing half: "denied" on its own produces a retry one directory over, and then another,
 * where "you work inside app/, api/" produces either the right path or an honest "this task needs more than I
 * have" — which is the answer the owner actually wants from a bounded session. */
const refusal = (scope: PersonaScope, sandboxPath: boolean): string =>
    sandboxPath
        ? `This persona may not change the sandbox's own configuration or its public outbox. If the task genuinely needs that, stop and say so rather than working around it.`
        : `This persona works inside ${scope.folders.join(", ")} — that path is outside it. If the task genuinely needs a file elsewhere in the workspace, stop and say so rather than working around it.`;

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
                    // An absent path is the tool's own default — Glob and Grep search the cwd, which is inside
                    // the scope by construction. Nothing to judge, and refusing it would break the common call.
                    if (typeof path !== "string") {
                        return {};
                    }
                    const target = resolve(scope.cwd, path);
                    // Outside the workspace entirely: not this setting's question. See the header.
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

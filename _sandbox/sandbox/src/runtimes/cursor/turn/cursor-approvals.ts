import type { AgentEvent, ProgramAsk } from "@intentic/sandbox-contract";
import type { AgentRequest } from "../../../agent/providers/agent-request.js";
import { z } from "zod";
import { opt } from "../../../opt.js";

// The per-tool card of a Cursor turn sent in `default` mode, the one posture that asks a person (the Claude Code loop's
// askOwner, agent/run/agent.ts): every call that changes something parks on a card until somebody answers. Raised from
// the three places a call can be stopped on this runtime: the preToolUse hook for Cursor's own tools, beforeMCPExecution
// for an MCP server's, and the daemon's custom-tool handlers, which Cursor runs past every hook and never asks about
// itself (options.d.ts: custom tools "never require interactive approval").

export interface CursorToolAsk {
    // The name the card files under and a "don't ask again" remembers.
    readonly toolName: string;
    readonly displayName: string;
    readonly title: string;
    readonly path?: string;
    // What would run, for a shell command or a script.
    readonly program?: { readonly text: string; readonly language: ProgramAsk["language"] };
}

export type CursorApproval = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export interface CursorOwner {
    // Resolves once a person answered, or at once where the turn asks nobody (another mode, the planning phase, a tool
    // the person said not to ask about again).
    readonly approve: (ask: CursorToolAsk) => Promise<CursorApproval>;
}

const ALLOWED: CursorApproval = { allow: true };

// How much of a program the card shows; the gate's own card clips the same way.
const SHOWN_PROGRAM = 2_000;

const programOf = (program: NonNullable<CursorToolAsk["program"]>): ProgramAsk => ({
    text: program.text.slice(0, SHOWN_PROGRAM),
    language: program.language,
    truncated: program.text.length > SHOWN_PROGRAM,
    spans: [],
});

/**
 * The turn's owner, or undefined for a turn in any mode but `default`, which runs every call without asking. `asking`
 * says whether the phase now running asks: a plan's first phase is read-only by Cursor's own plan mode and asks nobody.
 */
export const cursorOwner = (
    request: Pick<AgentRequest, "policy" | "hooks" | "spec">,
    push: (event: AgentEvent) => void,
    signal: AbortSignal,
    asking: () => boolean,
): CursorOwner | undefined => {
    if (request.policy.permissionMode !== "default") {
        return undefined;
    }
    // The tools the person said not to ask about again, for the rest of the turn.
    const always = new Set<string>();
    return {
        approve: async (ask) => {
            if (!asking() || always.has(ask.toolName)) {
                return ALLOWED;
            }
            // A card answered before a restart, consumed by the resumed turn's re-ask so it does not ask twice.
            const restored = request.hooks.restoredGrant?.(ask.toolName);
            if (restored !== undefined) {
                if (restored.always) {
                    always.add(ask.toolName);
                }
                return ALLOWED;
            }
            const { id, wait } = request.hooks.cards.create(
                "permission",
                { kind: "permission", requestId: "", decision: "deny", feedback: "The turn ended before you answered." },
                request.spec.conversationId,
            );
            push({
                kind: "permission",
                requestId: id,
                toolName: ask.toolName,
                title: ask.title,
                displayName: ask.displayName,
                reason: "You asked to approve each call in this conversation.",
                ...opt("path", ask.path),
                ...opt("program", ask.program === undefined ? undefined : programOf(ask.program)),
                alwaysLabel: `Don't ask again for ${ask.displayName}`,
            });
            const { reply, resolved } = await wait(signal);
            // Before the answer is acted on, so a replayed transcript freezes the card as it was answered.
            push(resolved);
            if (reply.decision === "deny") {
                // Feedback redirects and the turn goes on; a bare no stops the agent, as the Claude Code loop's does.
                const feedback = reply.feedback?.trim();
                return {
                    allow: false,
                    reason:
                        feedback !== undefined && feedback !== ""
                            ? feedback
                            : `The user declined ${ask.displayName} and stopped the turn. STOP what you are doing and wait for them to say how to proceed.`,
                };
            }
            if (reply.decision === "always" || reply.decision === "everything") {
                always.add(ask.toolName);
            }
            return ALLOWED;
        },
    };
};

// The fields of a built-in call's input a card shows; anything else is read as naming nothing.
export const AskFieldsSchema = z.object({
    command: z.string().min(1).optional().catch(undefined),
    file_path: z.string().min(1).optional().catch(undefined),
    url: z.string().min(1).optional().catch(undefined),
});

const shellAsk = (command: string | undefined): CursorToolAsk => ({
    toolName: "Shell",
    displayName: "Run command",
    title: "Run this command?",
    ...opt("program", command === undefined ? undefined : { text: command, language: "bash" as const }),
});

// The card for a built-in call by the name Cursor's hooks give its executor; undefined for a call that only reads,
// which the Claude Code loop's manual posture does not ask about either.
export const builtInAsk = (tool: string, fields: z.infer<typeof AskFieldsSchema>): CursorToolAsk | undefined => {
    switch (tool) {
        case "Shell":
            return shellAsk(fields.command);
        case "Write":
            return { toolName: "Write", displayName: "Edit file", title: "Edit this file?", ...opt("path", fields.file_path) };
        case "Delete":
            return { toolName: "Delete", displayName: "Delete file", title: "Delete this file?", ...opt("path", fields.file_path) };
        case "Fetch":
            return { toolName: "Fetch", displayName: "Fetch page", title: `Fetch ${fields.url ?? "this page"}?` };
        case "ComputerUse":
            return { toolName: tool, displayName: "Use the computer", title: "Let the agent use the screen?" };
        case "RecordScreen":
            return { toolName: tool, displayName: "Record the screen", title: "Let the agent record the screen?" };
        default:
            return undefined;
    }
};

// The card for an MCP server's tool.
export const mcpAsk = (server: string, tool: string): CursorToolAsk => ({
    toolName: `mcp__${server}__${tool}`,
    displayName: `${server} · ${tool}`,
    title: `Call ${tool} on ${server}?`,
});

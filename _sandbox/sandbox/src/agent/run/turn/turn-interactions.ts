import type { AgentReply, EditorContext } from "@intentic/sandbox-contract";
import type { Caller } from "../../../auth/auth.js";
import type { Services } from "../../../composition.js";
import { resolveWithin } from "../../../workspace/files/workspace-files-paths.js";
import { conversationOf, resolveRequest } from "../../tools/agent-requests.js";
import { steerTurn, stopTurn } from "../../anchors/agent-steering.js";
import { withAttachmentNote } from "../../prompt/attachment-note.js";
import { turnRunOf } from "./turn-runs.js";

// applyReply and applySteer are functions rather than route bodies: a parent sandbox forwards a remote card's answer
// here too (runners/), and duplicate "what a dismissal does" logic would drift between the two paths.

// Folds the open file and any selection into a note so deictic prompts ("fix this") ground without an @-mention.
// Four-backtick fence so a selection containing ``` doesn't break out.
export const editorContextNote = (context: EditorContext): string => {
    if (context.selection === undefined) {
        return `The user has \`${context.file}\` open in the editor: "this file" likely refers to it.`;
    }
    const range = context.startLine !== undefined && context.endLine !== undefined ? ` (lines ${context.startLine}-${context.endLine})` : "";
    return `The user has \`${context.file}\` open in the editor with this text selected${range}: "this" likely refers to it:\n\`\`\`\`\n${context.selection}\n\`\`\`\``;
};

// `missing` (no such card) maps to NOT_FOUND, `refused` (addressed to someone else) to FORBIDDEN with that reason.
// `caller` is the verified identity, not the body; optional since only a credential release cares who answered.
export const applyReply = async (
    services: Services,
    reply: AgentReply,
    caller?: Caller,
): Promise<"settled" | "missing" | { refused: string }> => {
    // A dismissed question ends the turn here, not in the browser: waving away a card the agent couldn't resolve
    // without it just lets it guess. Marked synchronously before resolving so the tool's own continuation can't
    // re-publish the agent as running.
    const dismissed = reply.kind === "question" && reply.cancelled === true ? conversationOf(reply.requestId) : undefined;
    if (dismissed !== undefined) {
        services.agents.stopping(dismissed, "dismissed");
    }
    const outcome = resolveRequest(reply, caller);
    if (outcome !== "settled") {
        return outcome;
    }
    if (dismissed === undefined) {
        return "settled";
    }
    stopTurn(dismissed);
    // Joined like the stop route: the reply must not return while the run still holds the conversation.
    await turnRunOf(dismissed)?.waitUntilFinished();
    return "settled";
};

export interface SteerInput {
    readonly text: string;
    readonly attachments?: readonly string[] | undefined;
    readonly editorContext?: EditorContext | undefined;
}

// Composed where the steer is delivered, not pre-composed: attachments resolve against the delivering daemon's own
// workspace, since a remote turn's paths differ. An escaping path is a refusal (BAD_REQUEST), not a sanitisation.
export type SteerText = { readonly text: string; readonly invalid?: undefined } | { readonly invalid: string; readonly text?: undefined };

export const composeSteerText = (services: Services, input: SteerInput): SteerText => {
    const paths: string[] = [];
    for (const rel of input.attachments ?? []) {
        const abs = resolveWithin(services.workspace.root, rel);
        if (abs === undefined) {
            return { invalid: `invalid attachment path: ${rel}` };
        }
        paths.push(abs);
    }
    if (input.editorContext !== undefined && resolveWithin(services.workspace.root, input.editorContext.file) === undefined) {
        return { invalid: `invalid editor context path: ${input.editorContext.file}` };
    }
    const withEditor = [input.text, ...(input.editorContext !== undefined ? [editorContextNote(input.editorContext)] : [])]
        .filter((part) => part !== "")
        .join("\n\n");
    return { text: paths.length > 0 ? withAttachmentNote(withEditor, paths) : withEditor };
};

// Delivers into the conversation's live turn; false means no steerable turn, read as "queue for the next turn".
export const applySteer = (conversationId: string, text: string): boolean => steerTurn(conversationId, text);

import type { AgentReply, EditorContext } from "@intentic/sandbox-contract";
import type { Caller } from "../auth/auth.js";
import type { Services } from "../composition.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { conversationOf, resolveRequest } from "./agent-requests.js";
import { steerTurn, stopTurn } from "./agent-steering.js";
import { withAttachmentNote } from "./attachment-note.js";
import { turnRunOf } from "./turn-runs.js";

/* ANSWERING A PARKED CARD, AND SPEAKING INTO A RUNNING TURN, as functions rather than route bodies, because
 * there are now two doors onto the same act: the browser's `/agent/reply` and `/agent/steer`, and a PARENT
 * sandbox forwarding either one to the runner a conversation lives on (runners/, docs/remote-runners-plan.md
 * at the workspace root).
 *
 * The forwarding is what forces the extraction. A card raised by a remote turn was minted in the RUNNER's
 * request registry, so the parent's own `resolveRequest` knows nothing about it; the answer has to travel and
 * be applied there, by exactly this code. Two implementations of "what a dismissal does to a turn" is the
 * kind of drift that ends with a question that closes on one machine and hangs on the other. */

// Fold the opt-in editor context (the composer chip, off by default) into a message: the file the user is
// looking at and, when they selected text, the lines themselves, so deictic prompts ("fix this") ground
// without an @-mention. Four-backtick fence so a selection containing ``` doesn't break out.
export const editorContextNote = (context: EditorContext): string => {
    if (context.selection === undefined) {
        return `The user has \`${context.file}\` open in the editor: "this file" likely refers to it.`;
    }
    const range = context.startLine !== undefined && context.endLine !== undefined ? ` (lines ${context.startLine}-${context.endLine})` : "";
    return `The user has \`${context.file}\` open in the editor with this text selected${range}: "this" likely refers to it:\n\`\`\`\`\n${context.selection}\n\`\`\`\``;
};

/* `settled` when the card was there and this person could answer it. `missing` when nothing holds that id
 * (already answered, or the turn ended), which the route surfaces as NOT_FOUND and a parent reads as "try the
 * runner". `refused` when the card is here but is addressed to somebody else — a gated credential's release
 * names its approvers — which the route surfaces as FORBIDDEN with that sentence, leaving the card parked for
 * whoever can answer it.
 *
 * `caller` is the identity the daemon VERIFIED on the request that carried the reply (context.identity), not
 * anything the body claimed. It is optional because most doors here have no identity to offer: loopback mode,
 * a panel token, and the runner relay below all arrive without one, and every card but the credential release
 * is indifferent to who answered. */
export const applyReply = async (
    services: Services,
    reply: AgentReply,
    caller?: Caller,
): Promise<"settled" | "missing" | { refused: string }> => {
    /* A DISMISSED QUESTION ENDS THE TURN, and it ends here rather than in the browser: the card was raised
     * because the agent could not choose, so waving it away answers nothing, and letting the turn run on
     * means it guesses at exactly the fork it just said it could not guess at.
     *
     * Marked before it is resolved, and synchronous down to the abort, so the tool's own continuation cannot
     * run in between and re-publish the agent as running. */
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
    // Joined like the stop route joins, and for the same reason: the answer to this request is what the
    // browser lets the user type behind, so it must not come back while the run still holds the conversation.
    // The wait is a blink, the turn is parked inside the card being dismissed.
    await turnRunOf(dismissed)?.waitUntilFinished();
    return "settled";
};

export interface SteerInput {
    readonly text: string;
    readonly attachments?: readonly string[] | undefined;
    readonly editorContext?: EditorContext | undefined;
}

/* The message a steer actually delivers: the user's words, then the editor-context note, then the attachment
 * note over paths resolved against THIS daemon's workspace. Composed where it will be DELIVERED, never
 * shipped pre-composed: a remote turn's attachments resolve against the runner's workspace root, and a
 * parent that baked its own absolute paths into the text would hand the agent files at paths its machine
 * does not have.
 *
 * A path that escapes the workspace is a refusal, not a sanitization: the caller turns it into BAD_REQUEST. */
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

// Deliver it into the conversation's running turn. False ⇒ no steerable turn is live here, which the client
// reads as "keep it queued for the next turn" and a parent reads as "the runner had nothing running".
export const applySteer = (conversationId: string, text: string): boolean => steerTurn(conversationId, text);

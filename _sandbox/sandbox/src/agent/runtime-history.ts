// A provider/harness/account switch starts a fresh runtime session. Carry the conversation's transcript in the
// opening prompt so the new runtime can continue the same conversation, then reverse that envelope when the SDK
// stores it: protocol must never become one giant user bubble on restore.
//
// The transcript comes from the DAEMON's own record (sessions/transcript-record.ts), not from the client, it is
// the authoritative account of what was streamed, it holds tool calls and attachments the client's text mirror
// drops, and it is keyed by conversationId, which is exactly the identity a retired session leaves behind.

import type { RestoredMessage, RestoredToolCall } from "@intentic/sandbox-contract";
import { formatAnswers } from "./question-answers.js";

export interface RuntimeHistoryMessage {
    readonly role: "user" | "assistant";
    readonly text: string;
}

const HEADER = "This conversation continues from another AI runtime. Prior transcript (oldest first): treat it as your own conversation history:";
const SEPARATOR = "\n\n---\n\n";
const MESSAGE_CHAR_CAP = 8_000;
/* What the whole preamble may spend, in characters, roughly 8k tokens. A handoff is orientation, not an archive:
 * tool output is already excluded and the newest turns carry the decisions the next runtime needs. The old
 * 120k cap let this optional note consume ~30k tokens before the current request, enough to crowd out small
 * models and to make a runtime switch more expensive than continuing the old session.
 *
 * Fixed rather than derived from the incoming model's context window because the switch happens before that
 * runtime has produced a usage frame. Context-window preflight still owns the total request; this local ceiling
 * prevents history from claiming an unbounded share of it. */
const HISTORY_CHAR_CAP = 32_000;
// Tool calls are carried as a trailing one-line index per assistant turn. WHAT the agent did, never the tool
// output, which is the bulk of a transcript and is re-readable from the workspace itself.
const TOOLS_PER_MESSAGE = 8;

const toolLabel = (call: RestoredToolCall): string => (call.target !== undefined && call.target !== "" ? `${call.name} ${call.target}` : call.name);

/* WHAT THE USER DECIDED at a question this row asked, the one thing on a card the next runtime cannot do
 * without: the picks steered everything the agent did afterwards, and the ask tool's result that carried them
 * is tool output, which this preamble excludes. Worded by the same function the model read them through live
 * (formatAnswers), on one line. A card with no reply was stopped under, and says nothing here. */
const decisionLabel = (message: RestoredMessage): string | undefined => {
    const question = message.question;
    if (question === undefined || question.reply?.kind !== "question") {
        return undefined;
    }
    return formatAnswers(question.questions, question.reply).replaceAll("\n", " ");
};

// The trailer that says what a turn touched: tool calls and the answer to a question it asked for an assistant
// message, attached files for a user's. Empty when there is nothing to say, so a plain text exchange renders
// exactly as it always did.
const trailerOf = (message: RestoredMessage): string => {
    if (message.role === "user") {
        const attachments = message.attachments ?? [];
        return attachments.length > 0 ? `\n[attached: ${attachments.join(", ")}]` : "";
    }
    const decision = decisionLabel(message);
    const asked = decision === undefined ? "" : `\n[asked: ${decision}]`;
    const tools = message.tools ?? [];
    if (tools.length === 0) {
        return asked;
    }
    const shown = tools.slice(0, TOOLS_PER_MESSAGE).map(toolLabel);
    const rest = tools.length - shown.length;
    return `${asked}\n[used: ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}]`;
};

const rendered = (message: RestoredMessage): string => {
    const body = message.text.length > MESSAGE_CHAR_CAP ? `${message.text.slice(0, MESSAGE_CHAR_CAP)}\n… (truncated)` : message.text;
    return `${body}${trailerOf(message)}`;
};

export const withRuntimeHistory = (prompt: string, history: readonly RestoredMessage[]): string => {
    const lines: string[] = [];
    let used = 0;
    // Newest first, so a transcript over budget keeps the end of the conversation rather than its opening.
    for (const message of history.toReversed()) {
        const line = `${message.role === "user" ? "User" : "Assistant"}: ${rendered(message)}`;
        if (used + line.length > HISTORY_CHAR_CAP) {
            break;
        }
        lines.unshift(line);
        used += line.length;
    }
    return `${HEADER}\n\n${lines.join("\n\n")}${SEPARATOR}${prompt}`;
};

export const parseRuntimeHistory = (text: string): { history: RuntimeHistoryMessage[]; prompt: string } | undefined => {
    const opening = `${HEADER}\n\n`;
    if (!text.startsWith(opening)) {
        return undefined;
    }
    const separator = text.lastIndexOf(SEPARATOR);
    if (separator < opening.length) {
        return undefined;
    }
    const encoded = text.slice(opening.length, separator);
    const matches = [...encoded.matchAll(/(?:^|\n\n)(User|Assistant): /gu)];
    if (matches.length === 0 || matches[0]?.index !== 0) {
        return undefined;
    }
    const history = matches.map((match, index): RuntimeHistoryMessage => {
        const start = (match.index ?? 0) + match[0].length;
        const end = matches[index + 1]?.index ?? encoded.length;
        return { role: match[1] === "User" ? "user" : "assistant", text: encoded.slice(start, end) };
    });
    return { history, prompt: text.slice(separator + SEPARATOR.length) };
};

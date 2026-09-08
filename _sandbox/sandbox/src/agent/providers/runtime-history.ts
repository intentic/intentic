// Carries a conversation's transcript in the new runtime's opening prompt across a provider/harness/account switch,
// then reverses the envelope on store so it never becomes one giant user bubble. Built from the daemon's own transcript
// record, not the client's, since it holds tool calls and attachments the client's mirror drops.

import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import { formatAnswers } from "../tools/question-answers.js";

export interface RuntimeHistoryMessage {
    readonly role: "user" | "assistant";
    readonly text: string;
}

const HEADER = "This conversation continues from another AI runtime. Prior transcript (oldest first): treat it as your own conversation history:";
const SEPARATOR = "\n\n---\n\n";
const MESSAGE_CHAR_CAP = 8_000;
// Char cap for an assistant message outside the newest RECENT_ROWS; user messages are never cut by this.
const OLDER_ASSISTANT_CHAR_CAP = 1_500;
// How many of the newest user/assistant rows keep the full cap: two exchanges, four rows.
const RECENT_ROWS = 4;
// Total preamble budget, in characters; fixed since the incoming model's context window isn't known yet.
const HISTORY_CHAR_CAP = 32_000;
// Max tool calls listed per assistant turn; never the tool output, which is re-readable from the workspace.
const TOOLS_PER_MESSAGE = 8;

const toolLabel = (call: TranscriptTool): string => (call.target !== undefined && call.target !== "" ? `${call.name} ${call.target}` : call.name);

// What the user decided at a question this row asked, worded through the same formatAnswers the model read live. A card
// with no reply says nothing.
const decisionLabel = (message: TranscriptRow): string | undefined => {
    const question = message.question;
    if (question === undefined || question.status !== "answered") {
        return undefined;
    }
    return formatAnswers(question.questions, { kind: "question", requestId: question.requestId, answers: question.answers }).replaceAll("\n", " ");
};

// Trailer for what a turn touched: tools and question answer for an assistant row, attachments for a user row; empty
// otherwise.
const trailerOf = (message: TranscriptRow): string => {
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

const rendered = (message: TranscriptRow, cap: number): string => {
    const body = message.text.length > cap ? `${message.text.slice(0, cap)}\n… (truncated)` : message.text;
    return `${body}${trailerOf(message)}`;
};

export const withRuntimeHistory = (prompt: string, history: readonly TranscriptRow[]): string => {
    const lines: string[] = [];
    let used = 0;
    // Newest first, so a transcript over budget keeps the end of the conversation rather than its opening.
    for (const [fromEnd, message] of history.toReversed().entries()) {
        const cap = message.role === "assistant" && fromEnd >= RECENT_ROWS ? OLDER_ASSISTANT_CHAR_CAP : MESSAGE_CHAR_CAP;
        const line = `${message.role === "user" ? "User" : "Assistant"}: ${rendered(message, cap)}`;
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

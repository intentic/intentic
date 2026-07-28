// A provider/harness switch starts a fresh runtime session. Carry the visible text transcript in the opening
// prompt so the new runtime can continue the same conversation, then reverse that envelope when the SDK stores
// it: protocol must never become one giant user bubble on restore.

export interface RuntimeHistoryMessage {
    readonly role: "user" | "assistant";
    readonly text: string;
}

const HEADER = "This conversation continues from another AI runtime. Prior transcript (oldest first) — treat it as your own conversation history:";
const SEPARATOR = "\n\n---\n\n";
const MESSAGE_CHAR_CAP = 4_000;
const HISTORY_CHAR_CAP = 24_000;

export const withRuntimeHistory = (prompt: string, history: readonly RuntimeHistoryMessage[]): string => {
    const lines: string[] = [];
    let used = 0;
    for (const message of history.toReversed()) {
        const text = message.text.length > MESSAGE_CHAR_CAP ? `${message.text.slice(0, MESSAGE_CHAR_CAP)}\n… (truncated)` : message.text;
        const line = `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
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

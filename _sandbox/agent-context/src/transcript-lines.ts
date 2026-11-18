// Which user line of a Claude Code transcript is which. The format is undocumented and drifts across claude-code
// versions (prompts were plain strings before v2.x, arrays of blocks now), so every accessor returns undefined on an
// unexpected shape and unknown line types and future fields pass through.

type Line = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): Line | undefined =>
    // SAFETY: a non-null, non-array object is a record of fields; Line claims nothing about any of them.
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Line) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const typeOf = (line: Line): string | undefined => asString(line["type"]);

// What a user line is, as far as who wrote it goes. A reader keeps its own policy on top: a turn starts at "typed" or
// "command", including a prompt that was only an image.
//   typed          what the person sent; its text is "" for a prompt that carried only images
//   command        a slash command the person typed (`<command-name>/review</command-name>`), echoed by the CLI
//   local-command  a local command's output or caveat (`<local-command-stdout>`), which the CLI writes, not the person
//   compaction     the summary a compaction leaves as the first line of the continued session (`isCompactSummary`)
//   interruption   the CLI's note that the person stopped the turn (`[Request interrupted by user]`)
//   meta           a line the harness inserted on the person's behalf (`isMeta`)
//   tool-result    the answers to the assistant's tool calls
export type PromptKind = "typed" | "command" | "local-command" | "compaction" | "interruption" | "meta" | "tool-result";

export interface Prompt {
    readonly kind: PromptKind;
    // The line's text blocks joined by newlines; "" when it had none.
    readonly text: string;
}

const INTERRUPTION = "[Request interrupted by user";

// Who wrote a user line that is not tool results, from its flags first and then from what its text opens with.
const kindOf = (line: Line, text: string): PromptKind => {
    if (line["isMeta"] === true) {
        return "meta";
    }
    if (line["isCompactSummary"] === true) {
        return "compaction";
    }
    if (text.startsWith("<local-command-")) {
        return "local-command";
    }
    if (text.startsWith("<command-")) {
        return "command";
    }
    return text.startsWith(INTERRUPTION) ? "interruption" : "typed";
};

// The kind and text of a user line; undefined for any other line, or a user line whose content is neither shape. Accepts
// both content shapes: a plain string (older claude-code) or an array of blocks (v2.x).
export const promptOf = (line: Line): Prompt | undefined => {
    if (typeOf(line) !== "user") {
        return undefined;
    }
    const content = asRecord(line["message"])?.["content"];
    let text: string;
    if (typeof content === "string") {
        text = content;
    } else if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
            const record = asRecord(block);
            if (record?.["type"] === "tool_result") {
                return { kind: "tool-result", text: "" };
            }
            const blockText = record?.["type"] === "text" ? asString(record["text"]) : undefined;
            if (blockText !== undefined) {
                texts.push(blockText);
            }
        }
        text = texts.join("\n");
    } else {
        return undefined;
    }
    return { kind: kindOf(line, text), text };
};

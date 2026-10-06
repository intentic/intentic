// Tolerant readers over transcript JSONL lines: undocumented and drifting across claude-code versions (prompts were
// plain strings before v2.x, arrays now). Every accessor returns undefined on an unexpected shape, so unknown line
// types and future fields pass through.

export type Line = Record<string, unknown>;

export const parseLine = (json: string): Line | undefined => {
    try {
        const value: unknown = JSON.parse(json);
        return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Line) : undefined;
    } catch {
        return undefined;
    }
};

const asRecord = (value: unknown): Line | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Line) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const typeOf = (line: Line): string | undefined => asString(line["type"]);

export const uuidOf = (line: Line): string | undefined => asString(line["uuid"]);

export const parentUuidOf = (line: Line): string | undefined => asString(line["parentUuid"]);

export const timestampOf = (line: Line): number | undefined => {
    const raw = asString(line["timestamp"]);
    if (raw === undefined) {
        return undefined;
    }
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? undefined : ms;
};

// What a user line is, as far as who wrote it goes. One classification for every reader of this format (iq's recall and
// fork here, and @intentic/agent-context's turn readings, which import it through `@intentic/iq/transcript`), so they
// cannot drift apart again on which lines a person wrote. Each reader keeps its own policy on top: recall indexes only
// "typed" text, while a turn starts at "typed" or "command", including a prompt that was only an image.
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

// The prompt the user actually typed, as text to search; undefined for every other kind of user line, for a prompt with
// no text (images only), and for non-user lines.
export const typedPromptOf = (line: Line): string | undefined => {
    const prompt = promptOf(line);
    return prompt?.kind === "typed" && prompt.text !== "" ? prompt.text : undefined;
};

// The assistant text of this line; undefined for tool-use-only, sidechain, and non-assistant lines. Sidechains
// (subagent threads) answer the subagent's prompt, not the user's turn.
export const assistantTextOf = (line: Line): string | undefined => {
    if (typeOf(line) !== "assistant" || line["isSidechain"] === true) {
        return undefined;
    }
    const content = asRecord(line["message"])?.["content"];
    if (!Array.isArray(content)) {
        return undefined;
    }
    const texts: string[] = [];
    for (const block of content) {
        const record = asRecord(block);
        const text = record?.["type"] === "text" ? asString(record["text"]) : undefined;
        if (text !== undefined) {
            texts.push(text);
        }
    }
    const joined = texts.join("\n");
    return joined === "" ? undefined : joined;
};

export interface FileTouch {
    readonly path: string;
    readonly modified: boolean;
}

const MODIFYING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Files this line pulled into or wrote from context, from the three places the transcript records them: assistant
// tool_use inputs, user toolUseResult payloads, and file-history snapshots.
export const fileTouchesOf = (line: Line): FileTouch[] => {
    const touches: FileTouch[] = [];
    const type = typeOf(line);
    if (type === "assistant") {
        const content = asRecord(line["message"])?.["content"];
        if (Array.isArray(content)) {
            for (const block of content) {
                const record = asRecord(block);
                if (record?.["type"] !== "tool_use") {
                    continue;
                }
                const name = asString(record["name"]) ?? "";
                const input = asRecord(record["input"]);
                const path = asString(input?.["file_path"]) ?? asString(input?.["notebook_path"]);
                if (path !== undefined && (name === "Read" || MODIFYING_TOOLS.has(name))) {
                    touches.push({ path, modified: MODIFYING_TOOLS.has(name) });
                }
            }
        }
        return touches;
    }
    if (type === "user") {
        const result = asRecord(line["toolUseResult"]);
        const readPath = asString(asRecord(result?.["file"])?.["filePath"]);
        if (readPath !== undefined) {
            touches.push({ path: readPath, modified: false });
        }
        const writePath = asString(result?.["filePath"]);
        if (writePath !== undefined) {
            touches.push({ path: writePath, modified: true });
        }
        return touches;
    }
    if (type === "file-history-snapshot") {
        const backups = asRecord(asRecord(line["snapshot"])?.["trackedFileBackups"]);
        for (const path of Object.keys(backups ?? {})) {
            touches.push({ path, modified: true });
        }
    }
    return touches;
};

export const aiTitleOf = (line: Line): string | undefined => (typeOf(line) === "ai-title" ? asString(line["aiTitle"]) : undefined);

export const leafUuidOf = (line: Line): string | undefined => (typeOf(line) === "last-prompt" ? asString(line["leafUuid"]) : undefined);

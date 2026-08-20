// Tolerant readers over transcript JSONL lines. The format is undocumented and drifts across claude-code
// versions (typed prompts were plain strings before v2.x, arrays now), every accessor returns undefined on
// unexpected shape instead of throwing, so unknown line types and future fields pass through ingestion.

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

// Slash-command echoes and harness caveats, user lines, but not something the user typed as a prompt.
const isCommandText = (text: string): boolean => text.startsWith("<command-") || text.startsWith("<local-command-");

// The prompt the user actually typed, or undefined for tool results, command echoes, and meta lines.
// Accepts both content shapes: plain string (older claude-code) and array of text blocks (v2.x).
export const typedPromptOf = (line: Line): string | undefined => {
    if (typeOf(line) !== "user" || line["isMeta"] === true) {
        return undefined;
    }
    const content = asRecord(line["message"])?.["content"];
    if (typeof content === "string") {
        return content === "" || isCommandText(content) ? undefined : content;
    }
    if (!Array.isArray(content)) {
        return undefined;
    }
    const texts: string[] = [];
    for (const block of content) {
        const record = asRecord(block);
        if (record === undefined) {
            continue;
        }
        if (record["type"] === "tool_result") {
            return undefined;
        }
        const text = record["type"] === "text" ? asString(record["text"]) : undefined;
        if (text !== undefined) {
            texts.push(text);
        }
    }
    const prompt = texts.join("\n");
    return prompt === "" || isCommandText(prompt) ? undefined : prompt;
};

// The assistant text of this line, or undefined for tool-use-only lines, sidechains, and non-assistant lines.
// Sidechains (subagent threads) are excluded, their text answers the subagent's prompt, not the user's turn.
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

// Files this line pulled into (or wrote from) the session's context, from all three places the transcript
// records them: assistant tool_use inputs, user toolUseResult payloads, and file-history snapshots.
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

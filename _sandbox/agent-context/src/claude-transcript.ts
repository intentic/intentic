import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { displayNameOf, toolCategoryOf, toolPathsUnder, toolTarget } from "./tool-calls.js";
import type { ToolCallFacts } from "./turn-metrics.js";

// A Claude Code session transcript (`~/.claude/projects/<project>/<session>.jsonl`), read back as turns of tool calls:
// the shape the turn readings score. One reader for everything that measures Claude Code sessions after the fact, the
// sandbox's benches and the Claude Code plugin's stats and field-notes evidence alike, so they count the same calls.
// A transcript is somebody else's file: every field is optional, and a line that does not parse is skipped rather than
// allowed to cost the whole session.

// A call as the readings see it, plus what the transcript alone can say about it.
export interface TranscriptCall extends ToolCallFacts {
    readonly id: string;
    readonly name: string;
    // Epoch ms of the line that carried it; undefined when the line had no usable stamp.
    readonly at: number | undefined;
    // Made by a subagent the turn started, rather than by the main thread.
    readonly subagent: boolean;
}

// A call that ended in error, with the start of what it answered.
export interface TranscriptFailure {
    readonly id: string;
    readonly text: string;
}

export interface TranscriptTurn {
    // 0 for the session's first real prompt.
    readonly index: number;
    readonly at: number;
    readonly prompt: string;
    readonly calls: TranscriptCall[];
    readonly failures: TranscriptFailure[];
}

export interface TranscriptSession {
    readonly sessionId: string | undefined;
    // The directory the session started in, as Claude Code recorded it.
    readonly cwd: string | undefined;
    readonly turns: TranscriptTurn[];
}

// Where a call's input points, relative to the session's root. The plain reading by default; the sandbox's benches pass
// the daemon's own, which also resolves the state directories linked into its tree.
export type Locate = (input: unknown, root: string) => readonly { readonly path: string }[] | undefined;

export interface TranscriptOptions {
    readonly root: string;
    readonly locate?: Locate;
}

type Block = Readonly<Record<string, unknown>>;

interface Line {
    readonly type?: string;
    readonly sessionId?: string;
    readonly cwd?: string;
    readonly timestamp?: string;
    readonly isMeta?: boolean;
    readonly isCompactSummary?: boolean;
    readonly isSidechain?: boolean;
    readonly message?: { readonly content?: readonly Block[] | string };
}

// Kept short: a failure's first lines say what went wrong, and a digest of hundreds of them has a budget to hold.
const FAILURE_TEXT_CHARS = 400;

const stampOf = (line: Line): number | undefined => {
    const at = line.timestamp === undefined ? Number.NaN : Date.parse(line.timestamp);
    return Number.isNaN(at) ? undefined : at;
};

const textOf = (content: unknown): string => {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((block: Block) => (block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : ""))
        .filter((text) => text !== "")
        .join("\n");
};

// Parsed only when it could carry a prompt, a call or a result: skipping the rest avoids JSON.parse over most of a
// transcript, which is mostly usage records, snapshots and hook attachments.
const parse = (raw: string): Line | undefined => {
    if (!raw.includes(`"type":"user"`) && !raw.includes(`"type":"assistant"`)) {
        return undefined;
    }
    try {
        return JSON.parse(raw) as Line;
    } catch {
        // allow(silent-catch): a line that is not JSON (a write torn by a crash, a shape a later CLI writes) is one lost line, the rest of the session still reads.
        return undefined;
    }
};

// Gone (rotated, deleted, never written), as opposed to there and unreadable, which is a failure worth hearing about.
const isMissing = (error: unknown): boolean => {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return code === "ENOENT" || code === "ENOTDIR";
};

// A prompt a person (or a harness on their behalf) sent, as opposed to a user line carrying tool results, a caveat the
// CLI inserted, a compaction summary, or a local command's echo. The only turn boundary this format has.
const promptOf = (line: Line): string | undefined => {
    if (line.type !== "user" || line.isMeta === true || line.isCompactSummary === true) {
        return undefined;
    }
    const content = line.message?.content;
    if (Array.isArray(content) && content.some((block: Block) => block["type"] === "tool_result")) {
        return undefined;
    }
    const text = textOf(content);
    return text.startsWith("<local-command-") ? undefined : text;
};

const callsOf = (line: Line, options: TranscriptOptions, subagent: boolean): TranscriptCall[] => {
    const content = line.message?.content;
    if (line.type !== "assistant" || !Array.isArray(content)) {
        return [];
    }
    const locate = options.locate ?? toolPathsUnder;
    const at = stampOf(line);
    return content.flatMap((block: Block, index): TranscriptCall[] => {
        const raw = block["name"];
        if (block["type"] !== "tool_use" || typeof raw !== "string") {
            return [];
        }
        const name = displayNameOf(raw);
        const target = toolTarget(block["input"]);
        const locations = locate(block["input"], options.root);
        return [
            {
                id: typeof block["id"] === "string" ? block["id"] : `${at ?? 0}-${index}`,
                name,
                category: toolCategoryOf(name),
                at,
                subagent,
                ...(target !== undefined ? { target } : {}),
                ...(locations !== undefined ? { locations } : {}),
            },
        ];
    });
};

const failuresOf = (line: Line): TranscriptFailure[] => {
    const content = line.message?.content;
    if (line.type !== "user" || !Array.isArray(content)) {
        return [];
    }
    return content.flatMap((block: Block) =>
        block["type"] === "tool_result" && block["is_error"] === true && typeof block["tool_use_id"] === "string"
            ? [{ id: block["tool_use_id"], text: (typeof block["content"] === "string" ? block["content"] : textOf(block["content"])).slice(0, FAILURE_TEXT_CHARS) }]
            : [],
    );
};

// One transcript file's text, as turns. A subagent's own file has no prompts of its own that count as turns (its first
// line is the task it was handed), so it is read for its calls alone (`subagent: true`) and merged by the caller.
export const readClaudeTranscript = (text: string, options: TranscriptOptions): TranscriptSession => {
    const turns: TranscriptTurn[] = [];
    let sessionId: string | undefined;
    let cwd: string | undefined;
    for (const raw of text.split("\n")) {
        const line = parse(raw);
        if (line === undefined) {
            continue;
        }
        sessionId ??= line.sessionId;
        cwd ??= line.cwd;
        const prompt = promptOf(line);
        if (prompt !== undefined) {
            turns.push({ index: turns.length, at: stampOf(line) ?? turns.at(-1)?.at ?? 0, prompt, calls: [], failures: [] });
            continue;
        }
        const turn = turns.at(-1);
        if (turn === undefined) {
            continue;
        }
        turn.calls.push(...callsOf(line, options, false));
        turn.failures.push(...failuresOf(line));
    }
    return { sessionId, cwd, turns };
};

// The calls and failures of every subagent the session started, in `<session>/subagents/*.jsonl`.
const subagentActivity = (file: string, options: TranscriptOptions): { calls: TranscriptCall[]; failures: (TranscriptFailure & { at: number | undefined })[] } => {
    const dir = join(dirname(file), basename(file, ".jsonl"), "subagents");
    let names: string[];
    try {
        names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
        return { calls: [], failures: [] };
    }
    const calls: TranscriptCall[] = [];
    const failures: (TranscriptFailure & { at: number | undefined })[] = [];
    for (const name of names) {
        let text: string;
        try {
            text = readFileSync(join(dir, name), "utf8");
        } catch {
            continue;
        }
        for (const raw of text.split("\n")) {
            const line = parse(raw);
            if (line === undefined) {
                continue;
            }
            calls.push(...callsOf(line, options, true));
            failures.push(...failuresOf(line).map((failure) => ({ ...failure, at: stampOf(line) })));
        }
    }
    return { calls, failures };
};

// The turn whose window [its prompt, the next prompt) holds a moment; the last turn holds everything after it.
const turnAt = (turns: readonly TranscriptTurn[], at: number | undefined): TranscriptTurn | undefined => {
    if (at === undefined) {
        return undefined;
    }
    let found: TranscriptTurn | undefined;
    for (const turn of turns) {
        if (turn.at <= at) {
            found = turn;
        }
    }
    return found;
};

// A whole session: its main transcript, with each subagent's calls counted as the turn's own that was running when they
// were made, the way the sandbox's live readings count them.
export const readClaudeSession = (file: string, options: TranscriptOptions): TranscriptSession | undefined => {
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    } catch (error) {
        if (isMissing(error)) {
            return undefined;
        }
        throw error;
    }
    const session = readClaudeTranscript(text, options);
    if (session.turns.length === 0) {
        return session;
    }
    const activity = subagentActivity(file, options);
    for (const call of activity.calls) {
        turnAt(session.turns, call.at)?.calls.push(call);
    }
    for (const { at, ...failure } of activity.failures) {
        turnAt(session.turns, at)?.failures.push(failure);
    }
    for (const turn of session.turns) {
        turn.calls.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
    }
    return session;
};

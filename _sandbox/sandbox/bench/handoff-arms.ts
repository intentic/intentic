import { readFileSync } from "node:fs";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { withRuntimeHistory } from "../src/agent/providers/runtime-history.js";

/* WHAT A CONTINUING SESSION IS HANDED AT A CUT, ONE BUILDER PER ARM.

   A cut is a point in a real Claude Code session (a line index into its JSONL) where the allowance ran out, or could
   have. Everything before it is what the old session knew; the arms differ in how much of that they pass on:
     carry   the session file up to the cut, resumed as is (what a cold-cache continue sends)
     trim    the same file with old tool output stubbed and thinking stripped; every word the user and the agent wrote
             and every tool call stays (no model call to build)
     seed    the fresh-session prompt Intentic builds today: withRuntimeHistory + a "where the work stands" note
     compact a summary written by a cheaper model over the whole transcript, plus the last exchanges verbatim
*/

export interface SessionLine {
    readonly raw: string;
    // Parsed entry; undefined for a line that is not JSON (kept verbatim, never edited).
    readonly entry: Entry | undefined;
}

interface Block {
    readonly type: string;
    readonly [key: string]: unknown;
}

interface Entry {
    readonly type?: string;
    readonly uuid?: string;
    readonly parentUuid?: string | null;
    readonly isSidechain?: boolean;
    readonly isMeta?: boolean;
    readonly isApiErrorMessage?: boolean;
    readonly isCompactSummary?: boolean;
    readonly sessionId?: string;
    readonly message?: {
        readonly id?: string;
        readonly model?: string;
        readonly content?: string | Block[];
        readonly usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
    };
    readonly [key: string]: unknown;
}

export const loadSession = (file: string): SessionLine[] =>
    readFileSync(file, "utf8")
        .split("\n")
        .filter((raw) => raw !== "")
        .map((raw) => {
            try {
                return { raw, entry: JSON.parse(raw) as Entry };
            } catch {
                return { raw, entry: undefined };
            }
        });

const isMain = (entry: Entry | undefined): entry is Entry => entry !== undefined && entry.isSidechain !== true && (entry.type === "user" || entry.type === "assistant");

const blocksOf = (entry: Entry): Block[] => {
    const content = entry.message?.content;
    return typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
};

// A message a person typed (or Intentic sent as the turn's prompt), as opposed to a tool result or harness meta.
export const humanText = (entry: Entry | undefined): string | undefined => {
    if (!isMain(entry) || entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) {
        return undefined;
    }
    const blocks = blocksOf(entry);
    if (blocks.some((block) => block.type === "tool_result")) {
        return undefined;
    }
    const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => String(block["text"] ?? ""))
        .join("\n")
        .trim();
    return text === "" || text.startsWith("<local-command") || text.startsWith("<command-") ? undefined : text;
};

// Context the model read on the API call behind this entry, or undefined for an entry with no usage of its own.
export const contextOf = (entry: Entry | undefined): number | undefined => {
    const usage = isMain(entry) && entry.type === "assistant" && entry.isApiErrorMessage !== true ? entry.message?.usage : undefined;
    return usage === undefined ? undefined : (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
};

export const contextBefore = (lines: readonly SessionLine[], cut: number): number => {
    for (let index = cut - 1; index >= 0; index -= 1) {
        const context = contextOf(lines[index]?.entry);
        if (context !== undefined) {
            return context;
        }
    }
    return 0;
};

// What the session actually knew at the cut: the ancestors of the entry the next line continued from, in file order.
// A session file also holds abandoned branches (a retried turn, a rewind) that no resume would load, so every arm and
// every reader starts from this chain rather than from every line above the cut.
export const chainBefore = (lines: readonly SessionLine[], cut: number): SessionLine[] => {
    const at = new Map<string, number>();
    for (let index = 0; index < cut; index += 1) {
        const uuid = lines[index]?.entry?.uuid;
        if (uuid !== undefined) {
            at.set(uuid, index);
        }
    }
    let leaf = lines[cut]?.entry?.parentUuid ?? undefined;
    if (leaf === undefined || !at.has(leaf)) {
        for (let index = cut - 1; index >= 0 && leaf === undefined; index -= 1) {
            leaf = isMain(lines[index]?.entry) ? lines[index]?.entry?.uuid : undefined;
        }
    }
    const kept: number[] = [];
    for (let uuid = leaf; uuid !== undefined && at.has(uuid); ) {
        const index = at.get(uuid)!;
        kept.push(index);
        uuid = lines[index]?.entry?.parentUuid ?? undefined;
    }
    return kept.toSorted((a, b) => a - b).map((index) => lines[index]!);
};

// Chars of message content the API is sent for the entries before the cut: the base the token estimate scales.
export const contentChars = (lines: readonly SessionLine[]): number =>
    lines.reduce((sum, line) => (isMain(line.entry) ? sum + JSON.stringify(line.entry.message?.content ?? "").length : sum), 0);

/* ---------- rendering, for the readers (probe author, judge, compactor) ---------- */

interface ToolCall {
    readonly name: string;
    readonly input: Record<string, unknown>;
}

const toolCalls = (lines: readonly SessionLine[]): Map<string, ToolCall> => {
    const calls = new Map<string, ToolCall>();
    for (const { entry } of lines) {
        if (isMain(entry) && entry.type === "assistant") {
            for (const block of blocksOf(entry)) {
                if (block.type === "tool_use") {
                    calls.set(String(block["id"]), { name: String(block["name"]), input: (block["input"] ?? {}) as Record<string, unknown> });
                }
            }
        }
    }
    return calls;
};

// The one argument that says what a call was about: the path, the command, the pattern.
export const targetOf = (call: ToolCall): string => {
    const input = call.input;
    for (const key of ["file_path", "path", "command", "pattern", "query", "url", "description", "subject", "prompt"]) {
        const value = input[key];
        if (typeof value === "string" && value !== "") {
            const flat = value.replaceAll(/\s+/gu, " ");
            return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
        }
    }
    return "";
};

const resultText = (block: Block): string => {
    const content = block["content"];
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return (content as Block[]).map((part) => (part.type === "text" ? String(part["text"] ?? "") : `[${part.type}]`)).join("\n");
    }
    return "";
};

const cap = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} more chars]` : text);

export interface RenderOptions {
    readonly resultCap: number;
    readonly inputCap: number;
}

// The session as a plain transcript: who said what, which tools ran on what, and (capped) what they returned.
export const renderTranscript = (lines: readonly SessionLine[], options: RenderOptions): string => {
    const calls = toolCalls(lines);
    const out: string[] = [];
    for (const { entry } of lines) {
        if (!isMain(entry) || entry.isApiErrorMessage === true) {
            continue;
        }
        const human = humanText(entry);
        if (human !== undefined) {
            out.push(`\n### USER\n${human}`);
            continue;
        }
        for (const block of blocksOf(entry)) {
            if (block.type === "text" && entry.type === "assistant") {
                out.push(`ASSISTANT: ${String(block["text"] ?? "")}`);
            } else if (block.type === "tool_use") {
                const input = JSON.stringify(block["input"] ?? {});
                out.push(`→ ${String(block["name"])} ${cap(input, options.inputCap)}`);
            } else if (block.type === "tool_result") {
                const call = calls.get(String(block["tool_use_id"]));
                const text = resultText(block);
                out.push(`← ${call?.name ?? "tool"}${block["is_error"] === true ? " (error)" : ""}: ${cap(text, options.resultCap)}`);
            }
        }
    }
    return out.join("\n");
};

/* ---------- carry and trim: session files ---------- */

const withSession = (entry: Entry, sessionId: string, parentUuid?: string | null): Entry => ({
    ...entry,
    ...(entry.sessionId === undefined ? {} : { sessionId }),
    ...(parentUuid === undefined ? {} : { parentUuid }),
});

// The prefix as a session file of its own: every line before the cut, renamed to the new session.
export const carrySession = (lines: readonly SessionLine[], cut: number, sessionId: string): string =>
    lines
        .slice(0, cut)
        .map((line) => (line.entry === undefined ? line.raw : JSON.stringify(withSession(line.entry, sessionId))))
        .join("\n")
        .concat("\n");

const THINKING = new Set(["thinking", "redacted_thinking"]);
const INPUT_STRING_CAP = 600;

const capInput = (value: unknown): unknown => {
    if (typeof value === "string") {
        return value.length > INPUT_STRING_CAP ? `${value.slice(0, INPUT_STRING_CAP)}… [${value.length - INPUT_STRING_CAP} chars cut at hand-off]` : value;
    }
    if (Array.isArray(value)) {
        return value.map(capInput);
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, capInput(inner)]));
    }
    return value;
};

export const stubFor = (call: ToolCall | undefined, text: string): string => {
    const lines = text === "" ? 0 : text.split("\n").length;
    const what = call === undefined ? "tool" : `${call.name}${targetOf(call) === "" ? "" : ` ${targetOf(call)}`}`;
    return `[Output cleared at hand-off to save context: ${what}, was ${lines} line${lines === 1 ? "" : "s"}. Run it again if you need it.]`;
};

export interface TrimStats {
    readonly cleared: number;
    readonly kept: number;
    readonly droppedLines: number;
}

// Keeps every user word, agent word and tool call; stubs all but the newest `keep` tool results, caps the inputs of the
// calls whose results went, and strips thinking (an edited history invalidates the thinking after it, and a model that
// did not write a block drops it anyway). A line left with no content is removed and its children re-parented, so the
// uuid chain the CLI resumes along stays whole.
export const trimSession = (lines: readonly SessionLine[], cut: number, keep: number, sessionId: string): { text: string; stats: TrimStats } => {
    const prefix = lines.slice(0, cut);
    const calls = toolCalls(prefix);
    const resultIds: string[] = [];
    for (const { entry } of prefix) {
        if (isMain(entry) && entry.type === "user") {
            for (const block of blocksOf(entry)) {
                if (block.type === "tool_result") {
                    resultIds.push(String(block["tool_use_id"]));
                }
            }
        }
    }
    const kept = new Set(resultIds.slice(Math.max(0, resultIds.length - keep)));
    const removed = new Map<string, string | null>();
    const out: string[] = [];
    let cleared = 0;
    for (const line of prefix) {
        const entry = line.entry;
        if (!isMain(entry) || typeof entry.message?.content === "string") {
            out.push(line.entry === undefined ? line.raw : JSON.stringify(entry));
            continue;
        }
        const content = blocksOf(entry).flatMap((block): Block[] => {
            if (THINKING.has(block.type)) {
                return [];
            }
            if (block.type === "tool_result" && !kept.has(String(block["tool_use_id"]))) {
                cleared += 1;
                return [{ ...block, content: stubFor(calls.get(String(block["tool_use_id"])), resultText(block)) }];
            }
            if (block.type === "tool_use" && !kept.has(String(block["id"]))) {
                return [{ ...block, input: capInput(block["input"]) }];
            }
            return [block];
        });
        if (content.length === 0 && entry.uuid !== undefined) {
            removed.set(entry.uuid, entry.parentUuid ?? null);
            continue;
        }
        out.push(JSON.stringify({ ...entry, message: { ...entry.message, content } }));
    }
    const reparent = (parent: string | null | undefined): string | null | undefined => {
        let current = parent;
        while (typeof current === "string" && removed.has(current)) {
            current = removed.get(current);
        }
        return current;
    };
    const text = out
        .map((raw) => {
            const entry = JSON.parse(raw) as Entry;
            return JSON.stringify(withSession(entry, sessionId, entry.parentUuid === undefined ? undefined : reparent(entry.parentUuid)));
        })
        .join("\n")
        .concat("\n");
    return { text, stats: { cleared, kept: kept.size, droppedLines: removed.size } };
};

/* ---------- seed: what Intentic hands a fresh session today ---------- */

// The session's turns as the daemon's transcript rows: one row per human message, one per assistant turn (its text
// joined, its tool calls listed by name and target), which is the shape withRuntimeHistory reads.
export const transcriptRows = (lines: readonly SessionLine[]): TranscriptRow[] => {
    const rows: TranscriptRow[] = [];
    let text: string[] = [];
    let tools: { name: string; target?: string }[] = [];
    const flush = (): void => {
        if (text.length > 0 || tools.length > 0) {
            rows.push({ role: "assistant", text: text.join("\n\n"), tools } as unknown as TranscriptRow);
        }
        text = [];
        tools = [];
    };
    for (const { entry } of lines) {
        if (!isMain(entry) || entry.isApiErrorMessage === true) {
            continue;
        }
        const human = humanText(entry);
        if (human !== undefined) {
            flush();
            rows.push({ role: "user", text: human } as unknown as TranscriptRow);
            continue;
        }
        if (entry.type === "assistant") {
            for (const block of blocksOf(entry)) {
                if (block.type === "text") {
                    text.push(String(block["text"] ?? ""));
                } else if (block.type === "tool_use") {
                    const target = targetOf({ name: String(block["name"]), input: (block["input"] ?? {}) as Record<string, unknown> });
                    tools.push({ name: String(block["name"]), ...(target === "" ? {} : { target }) });
                }
            }
        }
    }
    flush();
    return rows;
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// The note's two readings that survive in a session file: which files the session edited, and its checklist.
export const stateNote = (lines: readonly SessionLine[]): string => {
    const edited = new Set<string>();
    const tasks = new Map<string, { text: string; status: string }>();
    let todos: { content: string; status: string }[] | undefined;
    const calls = toolCalls(lines);
    for (const { entry } of lines) {
        if (!isMain(entry)) {
            continue;
        }
        for (const block of blocksOf(entry)) {
            if (block.type === "tool_use") {
                const input = (block["input"] ?? {}) as Record<string, unknown>;
                if (EDIT_TOOLS.has(String(block["name"])) && typeof input["file_path"] === "string") {
                    edited.add(input["file_path"]);
                }
                if (block["name"] === "TodoWrite" && Array.isArray(input["todos"])) {
                    todos = input["todos"] as { content: string; status: string }[];
                }
                if (block["name"] === "TaskUpdate" && typeof input["taskId"] === "string" && typeof input["status"] === "string") {
                    const task = tasks.get(input["taskId"]);
                    if (task !== undefined) {
                        tasks.set(input["taskId"], { ...task, status: input["status"] });
                    }
                }
            }
            if (block.type === "tool_result" && calls.get(String(block["tool_use_id"]))?.name === "TaskCreate") {
                const created = /Task #(\d+) created successfully: (.*)/u.exec(resultText(block));
                if (created !== null) {
                    tasks.set(created[1]!, { text: created[2]!, status: "pending" });
                }
            }
        }
    }
    const checklist = todos?.map((todo) => ({ text: todo.content, status: todo.status })) ?? [...tasks.values()].filter((task) => task.status !== "deleted");
    const sections = ["## Where the work stands\n\nMeasured by the sandbox, not recalled: trust it over memory. Read the diff in the tree for detail rather than re-deriving it."];
    if (edited.size > 0) {
        const paths = [...edited];
        sections.push(`### Changed in this conversation\n- ${paths.slice(0, 40).join(", ")}${paths.length > 40 ? `, +${paths.length - 40} more` : ""}`);
    }
    if (checklist.length > 0) {
        const open = checklist.filter((item) => item.status !== "completed").length;
        sections.push(
            `### The checklist the previous session kept (${open} of ${checklist.length} open)\n${checklist
                .slice(0, 40)
                .map((item) => `- [${item.status === "completed" ? "x" : " "}] ${item.text}${item.status === "in_progress" ? " (was in progress)" : ""}`)
                .join("\n")}\n${open === 0 ? "Every item is done; do not redo them." : `Re-create the open items in your own task list before continuing, and do not redo the ones marked done.`}`,
        );
    }
    return sections.join("\n\n").slice(0, 6_000);
};

export const seedPrompt = (lines: readonly SessionLine[], cut: number, next: string): string => {
    const prefix = lines.slice(0, cut);
    return `${stateNote(prefix)}\n\n${withRuntimeHistory(next, transcriptRows(prefix))}`;
};

/* ---------- compact: a cheaper model's summary ---------- */

export const COMPACT_INSTRUCTIONS = `You are writing the hand-off for a coding session that ran out of usage allowance. A new session, with none of this conversation in its context, will continue the work from your summary alone (plus the last exchanges verbatim, appended after it). It can read the repository, so file contents need not be copied; what it cannot recover is what was said, decided, tried and learned.

Write these sections, dense and specific (exact paths, commands, names, numbers, error messages):
1. The user's requests and intent: every explicit ask and constraint, in the user's own words where they matter, including corrections and preferences.
2. Decisions and their reasons, and approaches tried and abandoned (with why).
3. Files and code: which files were read, created or changed, and what about them matters.
4. Errors met and how they were fixed; tests and checks run and their last result.
5. Pending tasks: everything asked for and not yet done.
6. Current work: precisely what was being done right before the cut, and the next step, quoting the latest instruction verbatim.

Output only the summary.`;

export const compactPrompt = (rendering: string): string => `${COMPACT_INSTRUCTIONS}\n\n<transcript>\n${rendering}\n</transcript>`;

// Recent verbatim tail's ceiling in chars (~8k tokens): a mid-turn cut's last exchange can be a hundred-call turn.
const RECENT_CHAR_CAP = 30_000;

// The last `exchanges` human messages and everything after them, verbatim (tool output capped), from the prefix; past
// the ceiling the newest part wins.
export const lastExchanges = (lines: readonly SessionLine[], cut: number, exchanges: number, options: RenderOptions): string => {
    const text = recentRendering(lines, cut, exchanges, options);
    return text.length > RECENT_CHAR_CAP ? `[… earlier part of this stretch omitted]\n${text.slice(-RECENT_CHAR_CAP)}` : text;
};

const recentRendering = (lines: readonly SessionLine[], cut: number, exchanges: number, options: RenderOptions): string => {
    let start = 0;
    let seen = 0;
    for (let index = cut - 1; index >= 0; index -= 1) {
        if (humanText(lines[index]?.entry) !== undefined) {
            seen += 1;
            if (seen === exchanges) {
                start = index;
                break;
            }
        }
    }
    return renderTranscript(lines.slice(start, cut), options);
};

export const compactSeed = (summary: string, recent: string, next: string): string =>
    `This session continues work from an earlier conversation that ran out of usage allowance. A summary of that conversation:\n\n<summary>\n${summary}\n</summary>\n\nThe most recent part of it, verbatim (tool output shortened):\n\n<recent>\n${recent}\n</recent>\n\n---\n\n${next}`;

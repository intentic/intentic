import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import { type FleetRecallDeps, present } from "./fleet-recall.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { oneLine } from "@intentic/base/one-line";

// The record itself, for what the capsule did not cover, three ways: the last messages one line each with the tools each
// called (`--transcript`), the rows exactly as stored (`--transcript --json`), and one message whole (`--message <n>`).
// Agents used to hand-parse the zstd record with python or jq, guessing at its schema and getting it wrong, because the
// line view cut every message to one line and dropped what its tools were called with.

const collapse = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

const clamp = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const foldOf = (text: string): string => text.toLowerCase();

// One message of the record as a line view shows it; `at` is its position in the whole record, what `--message` takes.
export interface FleetMessage {
    readonly role: TranscriptRow["role"];
    readonly text: string;
    readonly sentAt?: number;
    readonly at: number;
    // Each call this message made, as `name target`, one line each and at most TOOL_LINES of them.
    readonly tools?: readonly string[];
    // How many calls it made past the ones listed.
    readonly moreTools?: number;
    // The questions a card in it asked.
    readonly asked?: readonly string[];
}

const MESSAGE_CHARS = 1200;
const MESSAGE_LIMIT = 20;
const TOOL_CHARS = 160;
const TOOL_LINES = 12;

export interface TranscriptOptions {
    readonly last?: number;
    readonly grep?: string;
}

const toolLine = (tool: TranscriptTool): string =>
    oneLine([tool.name, tool.target ?? tool.subagent?.description ?? tool.input ?? ""].join(" "), TOOL_CHARS);

const questionsOf = (row: TranscriptRow): string[] => (row.question?.questions ?? []).map((asked) => asked.question);

// What a grep reads of a row: what it said, what its tools were called with (a delegation's own calls included), and
// what its cards asked, so `--grep front.sock` finds the command that touched it and not only a sentence naming it.
const searchable = (row: TranscriptRow): string => {
    const calls = (tools: readonly TranscriptTool[]): string[] => tools.flatMap((tool) => [toolLine(tool), ...calls(tool.children ?? [])]);
    return foldOf([row.text, ...calls(row.tools ?? []), ...questionsOf(row)].join("\n"));
};

const lineOf = (row: TranscriptRow, at: number): FleetMessage | undefined => {
    const text = collapse(row.text);
    const tools = (row.tools ?? []).map(toolLine);
    const asked = questionsOf(row);
    if (text === "" && tools.length === 0 && asked.length === 0) {
        return undefined;
    }
    return {
        role: row.role,
        text: clamp(text, MESSAGE_CHARS),
        at,
        ...present({
            sentAt: row.sentAt,
            tools: tools.length === 0 ? undefined : tools.slice(0, TOOL_LINES),
            moreTools: tools.length > TOOL_LINES ? tools.length - TOOL_LINES : undefined,
            asked: asked.length === 0 ? undefined : asked,
        }),
    };
};

// The rows a window selects, each with its position: grep narrows before `last` limits, newest kept.
interface RecordWindow {
    // How many rows matched, before `last` cut them down.
    readonly total: number;
    // The positions of the rows kept, oldest first.
    readonly picked: readonly number[];
}

const windowOf = (rows: readonly TranscriptRow[], options: TranscriptOptions): RecordWindow => {
    const needle = options.grep === undefined ? undefined : foldOf(options.grep);
    const matched = rows.flatMap((row, at) => (needle === undefined || searchable(row).includes(needle) ? [at] : []));
    return { total: matched.length, picked: matched.slice(-Math.max(1, options.last ?? MESSAGE_LIMIT)) };
};

const rowsOf = (deps: FleetRecallDeps, entry: PersistedAgent): Promise<TranscriptRow[]> => deps.transcripts.rows(entry).catch((): TranscriptRow[] => []);

/** The last messages one line each (each with its tool calls), `grep` narrowing before the limit. */
export const fleetMessages = async (
    deps: FleetRecallDeps,
    entry: PersistedAgent,
    options: TranscriptOptions = {},
): Promise<{ readonly total: number; readonly messages: readonly FleetMessage[] }> => {
    const rows = await rowsOf(deps, entry);
    const lines = rows.flatMap((row, at) => {
        const line = lineOf(row, at);
        return line === undefined ? [] : [{ row, line }];
    });
    const { total, picked } = windowOf(
        lines.map(({ row }) => row),
        options,
    );
    return { total, messages: picked.flatMap((index) => lines[index]?.line ?? []) };
};

/** The same window as stored: whole rows, each with its position, for a reader that wants every field. */
export const fleetRows = async (
    deps: FleetRecallDeps,
    entry: PersistedAgent,
    options: TranscriptOptions = {},
): Promise<{ readonly total: number; readonly rows: readonly (TranscriptRow & { readonly at: number })[] }> => {
    const rows = await rowsOf(deps, entry);
    const { total, picked } = windowOf(rows, options);
    return { total, rows: picked.flatMap((at) => (rows[at] === undefined ? [] : [{ ...rows[at], at }])) };
};

// One message whole, bounded so a message that pasted a log cannot flood a shell: its text up to TEXT_CHARS, and each
// call with its target, its input where it had no target, how it ended and the head of its output.
const TEXT_CHARS = 20_000;
const OUTPUT_CHARS = 2_000;
const CHILD_LINES = 40;

export interface FleetCall {
    readonly name: string;
    readonly status: string;
    readonly target?: string;
    readonly input?: string;
    readonly exitCode?: number;
    readonly ms?: number;
    // The head of what it printed, and how much more there was.
    readonly output?: string;
    readonly outputChars?: number;
    // The subagent it started: what it was asked, and its report.
    readonly subagent?: { readonly description?: string; readonly status: string; readonly summary?: string };
    // A delegation's own calls, one line each.
    readonly calls?: readonly string[];
}

export interface FleetMessageDetail {
    readonly at: number;
    readonly role: TranscriptRow["role"];
    readonly text: string;
    readonly textChars: number;
    readonly sentAt?: number;
    readonly run?: string;
    readonly speaker?: TranscriptRow["speaker"];
    readonly notes?: readonly string[];
    readonly asked?: readonly { readonly question: string; readonly answers?: readonly string[] }[];
    readonly calls: readonly FleetCall[];
}

const outputOf = (tool: TranscriptTool): string =>
    (tool.content ?? []).map((part) => (part.type === "text" ? part.text : part.type === "diff" ? `(diff of ${part.path})` : `(${part.type})`)).join("\n");

const callOf = (tool: TranscriptTool): FleetCall => {
    const output = outputOf(tool);
    const children = (tool.children ?? []).flatMap(function lines(child: TranscriptTool): string[] {
        return [toolLine(child), ...(child.children ?? []).flatMap(lines)];
    });
    const { subagent } = tool;
    return {
        name: tool.name,
        status: tool.status,
        ...present({
            target: tool.target,
            input: tool.target === undefined ? tool.input : undefined,
            exitCode: tool.exitCode,
            ms: tool.startedAt !== undefined && tool.endedAt !== undefined ? tool.endedAt - tool.startedAt : undefined,
            output: output === "" ? undefined : clamp(output, OUTPUT_CHARS),
            outputChars: output === "" ? undefined : output.length,
            subagent:
                subagent === undefined
                    ? undefined
                    : { status: subagent.status, ...present({ description: subagent.description, summary: subagent.summary }) },
            calls: children.length === 0 ? undefined : children.slice(0, CHILD_LINES),
        }),
    };
};

/** One message whole, by its position in the record; undefined past its end. */
export const fleetMessageDetail = async (deps: FleetRecallDeps, entry: PersistedAgent, at: number): Promise<FleetMessageDetail | undefined> => {
    const row = (await rowsOf(deps, entry))[at];
    if (row === undefined) {
        return undefined;
    }
    const asked = (row.question?.questions ?? []).map((question) => ({
        question: question.question,
        ...present({ answers: row.question?.answers?.[question.question] }),
    }));
    return {
        at,
        role: row.role,
        text: clamp(row.text, TEXT_CHARS),
        textChars: row.text.length,
        ...present({
            sentAt: row.sentAt,
            run: row.run,
            speaker: row.speaker,
            notes: row.notes === undefined || row.notes.length === 0 ? undefined : row.notes.map((note) => note.title),
            asked: asked.length === 0 ? undefined : asked,
        }),
        calls: (row.tools ?? []).map(callOf),
    };
};

import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TRIM_KEEPS_RESULTS } from "@intentic/sandbox-contract";

/* A COPY OF A CLAUDE CODE SESSION, TO RESUME INSTEAD OF THE ORIGINAL.

   When a spent allowance holds a turn and the prompt cache has gone cold, resuming the session re-reads all of it, and
   every call of the next turn reads it again. Most of it is old tool output (~94% by characters, measured over 400
   sessions: sandbox/bench/handoff-bench.ts). A trimmed copy keeps every word the person and the agent wrote and every
   tool call, and replaces all but the newest tool results with a one-line stub naming what was there; it strips
   thinking too, since an edited history invalidates the thinking after it and no other session can read it anyway.

   The copy is written beside the original under a new id, so the CLI resumes it exactly as it resumes the original, and
   the original stays untouched: the conversation's history, a rewind and a fork all still read it. */

export interface SessionLine {
    readonly raw: string;
    // Parsed entry; undefined for a line that is not JSON, which is kept verbatim and never edited.
    readonly entry: SessionEntry | undefined;
}

export interface SessionBlock {
    readonly type: string;
    readonly [key: string]: unknown;
}

export interface SessionEntry {
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
        readonly content?: string | SessionBlock[];
        readonly usage?: {
            readonly input_tokens?: number;
            readonly cache_read_input_tokens?: number;
            readonly cache_creation_input_tokens?: number;
            readonly output_tokens?: number;
        };
    };
    readonly [key: string]: unknown;
}

export const parseSession = (text: string): SessionLine[] =>
    text
        .split("\n")
        .filter((raw) => raw !== "")
        .map((raw) => {
            try {
                return { raw, entry: JSON.parse(raw) as SessionEntry };
            } catch {
                return { raw, entry: undefined };
            }
        });

export const isMainEntry = (entry: SessionEntry | undefined): entry is SessionEntry =>
    entry !== undefined && entry.isSidechain !== true && (entry.type === "user" || entry.type === "assistant");

export const blocksOf = (entry: SessionEntry): SessionBlock[] => {
    const content = entry.message?.content;
    return typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
};

// A message a person typed (or the sandbox sent as the turn's prompt), as opposed to a tool result or harness meta.
export const humanText = (entry: SessionEntry | undefined): string | undefined => {
    if (!isMainEntry(entry) || entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) {
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

// Context the model read on the API call behind this entry; undefined for an entry with no usage of its own.
export const contextOf = (entry: SessionEntry | undefined): number | undefined => {
    const usage = isMainEntry(entry) && entry.type === "assistant" && entry.isApiErrorMessage !== true ? entry.message?.usage : undefined;
    return usage === undefined ? undefined : (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
};

// What the session knew at `cut`: the ancestors of the entry the next line continued from, in file order. A session
// file also holds abandoned branches (a retried request, a rewind) that no resume loads, so a copy starts from this
// chain rather than from every line above the cut.
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
        leaf = undefined;
        for (let index = cut - 1; index >= 0 && leaf === undefined; index -= 1) {
            leaf = isMainEntry(lines[index]?.entry) ? lines[index]?.entry?.uuid : undefined;
        }
    }
    const kept: number[] = [];
    const seen = new Set<string>();
    for (let uuid = leaf; uuid !== undefined && at.has(uuid) && !seen.has(uuid); ) {
        seen.add(uuid);
        const index = at.get(uuid)!;
        kept.push(index);
        uuid = lines[index]?.entry?.parentUuid ?? undefined;
    }
    return kept.toSorted((a, b) => a - b).map((index) => lines[index]!);
};

// The chain without what the refused request left at its end: the provider's error reply, and (when `unanswered` is
// dropped) the person's message nothing answered, which the re-run sends again with its own note. Tool results at the
// end stay: they answer the tool calls above them, and a call left without its result is refused by the API.
export const answeredChain = (chain: readonly SessionLine[], dropUnanswered: boolean): SessionLine[] => {
    let end = chain.length;
    while (end > 0) {
        const entry = chain[end - 1]?.entry;
        const failed = entry?.type === "assistant" && entry.isApiErrorMessage === true;
        const unanswered = dropUnanswered && humanText(entry) !== undefined;
        if (!failed && !unanswered && isMainEntry(entry)) {
            break;
        }
        end -= 1;
    }
    return chain.slice(0, end);
};

// Chars of message content the API is sent for these entries: the base a token estimate scales.
export const contentChars = (lines: readonly SessionLine[]): number =>
    lines.reduce((sum, line) => (isMainEntry(line.entry) ? sum + JSON.stringify(line.entry.message?.content ?? "").length : sum), 0);

interface ToolCall {
    readonly name: string;
    readonly input: Record<string, unknown>;
}

const toolCalls = (lines: readonly SessionLine[]): Map<string, ToolCall> => {
    const calls = new Map<string, ToolCall>();
    for (const { entry } of lines) {
        if (isMainEntry(entry) && entry.type === "assistant") {
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
    for (const key of ["file_path", "path", "command", "pattern", "query", "url", "description", "subject", "prompt"]) {
        const value = call.input[key];
        if (typeof value === "string" && value !== "") {
            const flat = value.replaceAll(/\s+/gu, " ");
            return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
        }
    }
    return "";
};

export const resultText = (block: SessionBlock): string => {
    const content = block["content"];
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return (content as SessionBlock[]).map((part) => (part.type === "text" ? String(part["text"] ?? "") : `[${part.type}]`)).join("\n");
    }
    return "";
};

export const stubFor = (call: ToolCall | undefined, text: string): string => {
    const lines = text === "" ? 0 : text.split("\n").length;
    const what = call === undefined ? "tool" : `${call.name}${targetOf(call) === "" ? "" : ` ${targetOf(call)}`}`;
    return `[Output cleared at hand-off to save context: ${what}, was ${lines} line${lines === 1 ? "" : "s"}. Run it again if you need it.]`;
};

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

const withSession = (entry: SessionEntry, sessionId: string, parentUuid?: string | null): SessionEntry => ({
    ...entry,
    ...(entry.sessionId === undefined ? {} : { sessionId }),
    ...(parentUuid === undefined ? {} : { parentUuid }),
});

export interface CopyStats {
    readonly cleared: number;
    readonly kept: number;
    readonly droppedLines: number;
}

// The chain as a session file of its own, renamed to `sessionId`. With a finite `keep`, every user word, agent word and
// tool call stays while all but the newest `keep` tool results become stubs, the inputs of the calls whose results went
// are capped, and thinking is stripped; `keep: Infinity` copies the messages whole and only strips thinking. A line
// left with no content is removed and its children re-parented, so the uuid chain the CLI resumes along stays whole.
export const copySession = (chain: readonly SessionLine[], keep: number, sessionId: string): { text: string; stats: CopyStats } => {
    const calls = toolCalls(chain);
    const resultIds: string[] = [];
    for (const { entry } of chain) {
        if (isMainEntry(entry) && entry.type === "user") {
            for (const block of blocksOf(entry)) {
                if (block.type === "tool_result") {
                    resultIds.push(String(block["tool_use_id"]));
                }
            }
        }
    }
    const kept = new Set(keep === Number.POSITIVE_INFINITY ? resultIds : resultIds.slice(Math.max(0, resultIds.length - keep)));
    const removed = new Map<string, string | null>();
    const out: SessionEntry[] = [];
    const raw: string[] = [];
    let cleared = 0;
    for (const line of chain) {
        const entry = line.entry;
        if (entry === undefined) {
            raw.push(line.raw);
            continue;
        }
        if (!isMainEntry(entry) || typeof entry.message?.content === "string") {
            out.push(entry);
            continue;
        }
        const content = blocksOf(entry).flatMap((block): SessionBlock[] => {
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
        out.push({ ...entry, message: { ...entry.message, content } });
    }
    const reparent = (parent: string | null | undefined): string | null | undefined => {
        let current = parent;
        while (typeof current === "string" && removed.has(current)) {
            current = removed.get(current);
        }
        return current;
    };
    const text = [...raw, ...out.map((entry) => JSON.stringify(withSession(entry, sessionId, entry.parentUuid === undefined ? undefined : reparent(entry.parentUuid))))]
        .join("\n")
        .concat("\n");
    return { text, stats: { cleared, kept: kept.size, droppedLines: removed.size } };
};

/* ---------- on disk ---------- */

// A session id is the CLI's own UUID; anything else is refused rather than joined into a path.
const SESSION_ID = /^[\w-]+$/u;

// The CLI files a transcript under its cwd, sanitized; the id alone finds it wherever the turn ran.
export const sessionFileOf = async (store: string, sessionId: string): Promise<string | undefined> => {
    if (!SESSION_ID.test(sessionId)) {
        return undefined;
    }
    const projects = join(store, "projects");
    const dirs = await readdir(projects, { withFileTypes: true }).catch(() => []);
    const paths = dirs.filter((dir) => dir.isDirectory()).map((dir) => join(projects, dir.name, `${sessionId}.jsonl`));
    const found = await Promise.all(paths.map(async (path) => ((await stat(path).catch(() => undefined))?.isFile() === true ? path : undefined)));
    return found.find((path) => path !== undefined);
};

// What resuming the session would carry, measured on the file: the chain a resume loads, with the refused request's
// leftovers dropped. Undefined when the store holds no such session, or it holds nothing to carry.
export const readSessionChain = async (store: string, sessionId: string, dropUnanswered: boolean): Promise<{ path: string; chain: SessionLine[] } | undefined> => {
    const path = await sessionFileOf(store, sessionId);
    if (path === undefined) {
        return undefined;
    }
    const lines = parseSession(await readFile(path, "utf8"));
    const chain = answeredChain(chainBefore(lines, lines.length), dropUnanswered);
    return chain.some((line) => isMainEntry(line.entry) && line.entry.type === "assistant") ? { path, chain } : undefined;
};

// The newest context a call in the chain measured: what resuming it re-reads, give or take the request on top.
export const chainContext = (chain: readonly SessionLine[]): number | undefined => {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const context = contextOf(chain[index]?.entry);
        if (context !== undefined) {
            return context;
        }
    }
    return undefined;
};

// The part of a context that is not the conversation (system prompt, tool definitions), which no trim shrinks. Read off
// the session's first call when it has one, capped: a first call already carrying a long prompt is mostly conversation.
const OVERHEAD_CAP = 30_000;

const overheadOf = (chain: readonly SessionLine[]): number => {
    for (const line of chain) {
        const context = contextOf(line.entry);
        if (context !== undefined) {
            return Math.min(context, OVERHEAD_CAP);
        }
    }
    return OVERHEAD_CAP;
};

export interface CopyEstimate {
    // What resuming the session as it is re-reads.
    readonly carryTokens: number;
    // What a trimmed copy would start from.
    readonly trimTokens: number;
    // How many tool outputs trimming clears.
    readonly cleared: number;
    // The part of either that is not the conversation (system prompt, tool definitions), which a fresh session pays too.
    readonly overhead: number;
}

// The two sizes, scaled from the session's own measured context by the share of its characters each keeps: tokens per
// character differ between sessions (code, prose, JSON), so the session's own ratio, not a constant, carries it.
export const estimateCopy = (chain: readonly SessionLine[], measured: number | undefined): CopyEstimate | undefined => {
    const carryTokens = measured ?? chainContext(chain);
    if (carryTokens === undefined) {
        return undefined;
    }
    const full = contentChars(chain);
    const { text, stats } = copySession(chain, TRIM_KEEPS_RESULTS, "estimate");
    const trimmed = contentChars(parseSession(text));
    const overhead = Math.min(carryTokens, overheadOf(chain));
    const perChar = full === 0 ? 0 : (carryTokens - overhead) / full;
    return { carryTokens, trimTokens: Math.round(overhead + trimmed * perChar), cleared: stats.cleared, overhead };
};

// Writes the copy beside the original and answers its id, which a turn resumes like any session. `keep` as copySession.
export const writeSessionCopy = async (
    store: string,
    sessionId: string,
    options: { readonly keep: number; readonly dropUnanswered: boolean },
): Promise<({ readonly sessionId: string } & CopyStats & { readonly chars: number; readonly fromChars: number }) | undefined> => {
    const read = await readSessionChain(store, sessionId, options.dropUnanswered);
    if (read === undefined) {
        return undefined;
    }
    const copyId = randomUUID();
    const { text, stats } = copySession(read.chain, options.keep, copyId);
    await writeFile(join(dirname(read.path), `${copyId}.jsonl`), text, { flag: "wx" });
    return { sessionId: copyId, ...stats, chars: contentChars(parseSession(text)), fromChars: contentChars(read.chain) };
};

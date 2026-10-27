import { open } from "node:fs/promises";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { parseJsonWith } from "@intentic/base/json";

/* WHAT A LONG TURN IS TOLD ABOUT ITS OWN SIZE.

   Every model call re-reads the whole context, so a call's price follows the context's size, and a 1M-token window
   lets a turn grow far past where that is worth it before anything (compaction) steps in: Claude turns compacted 12
   times in the month to 2026-10-26. Measured on the usage ledger over that month: a model call cost a median $0.035
   under 100k tokens of context, $0.069 at 200k-400k, $0.110 at 400k-700k and $0.175 above, and the turns that ended
   past 400k were 20% of turns and 53% of all spend. Those turns were mostly reading: `sed -n` and Read output was about
   half of what they carried, and the costliest were fan-outs whose subagents each read a hundred slices.

   A prompt paragraph about it decays as the context grows, which is exactly when it would matter, so this says it at
   the moment a line is crossed, once per line, after a tool call (the seam the search notices use). The size is the
   last main-thread request's input as the CLI's own transcript records it (input plus both cache buckets, what the
   stream's context_usage frame reports at the end), read off the file's tail. Main thread only: a subagent's hook
   input carries `agent_id`, and its context is its own. Never throws and never holds a call: a transcript it cannot
   read says nothing. */

// The lines a turn is told at: before the 400k step, where a call costs about three times what it did under 100k,
// and again before the 700k one, where it costs five times.
const CONTEXT_BUDGET_LINES: readonly number[] = [350_000, 650_000];

// One read's worth of the transcript's tail; a tool result bigger than this between two requests is walked past in
// further reads, up to the limit.
const CHUNK_BYTES = 64 * 1024;
const TAIL_LIMIT_BYTES = 1024 * 1024;

const ASSISTANT_MARK = `"type":"assistant"`;

// Only what this reads of a transcript record; the CLI's lines carry much more, which passes through unread.
const RequestRecordSchema = z.object({
    type: z.literal("assistant"),
    isSidechain: z.boolean().optional(),
    message: z.object({
        usage: z.object({
            input_tokens: z.number().optional(),
            cache_read_input_tokens: z.number().optional(),
            cache_creation_input_tokens: z.number().optional(),
        }),
    }),
});

// The context a main-thread request sent, off one transcript line; undefined for any other line.
export const requestTokensOn = (line: string): number | undefined => {
    const record = line.includes(ASSISTANT_MARK) ? parseJsonWith(line, RequestRecordSchema) : undefined;
    if (record === undefined || record.isSidechain === true) {
        return undefined;
    }
    const usage = record.message.usage;
    return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
};

const latestIn = (text: string): number | undefined => {
    for (const line of text.split("\n").toReversed()) {
        const tokens = requestTokensOn(line);
        if (tokens !== undefined) {
            return tokens;
        }
    }
    return undefined;
};

// Walks the transcript backwards a chunk at a time; the bytes before a chunk's first line break wait for the next read.
export const lastRequestTokens = async (path: string): Promise<number | undefined> => {
    // allow(silent-catch): a transcript this process cannot open (none yet, another namespace) is a turn told nothing.
    const file = await open(path, "r").catch(() => undefined);
    if (file === undefined) {
        return undefined;
    }
    try {
        const { size } = await file.stat();
        let end = size;
        let carried = Buffer.alloc(0);
        while (end > 0 && size - end < TAIL_LIMIT_BYTES) {
            const start = Math.max(0, end - CHUNK_BYTES);
            const chunk = Buffer.alloc(end - start);
            await file.read(chunk, 0, chunk.length, start);
            const text = Buffer.concat([chunk, carried]);
            const cut = start === 0 ? -1 : text.indexOf(0x0a);
            const tokens = latestIn(text.subarray(cut + 1).toString("utf8"));
            if (tokens !== undefined || start === 0) {
                return tokens;
            }
            carried = cut === -1 ? text : text.subarray(0, cut);
            end = start;
        }
        return undefined;
    } catch {
        // allow(silent-catch): a read that fails mid-file says nothing this call; the next call reads again.
        return undefined;
    } finally {
        await file.close();
    }
};

const thousands = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

const contextBudgetNotice = (tokens: number): string =>
    `This turn's context is now about ${thousands(tokens)} tokens, and every further model call re-reads all of it: ` +
    "past 400k a call costs about three times what it did under 100k, past 700k five times. Spend what is left " +
    "deliberately. Work from what you have already read instead of reading it again; when you must read, take the " +
    "lines you need (`rg -n` for the place, then a narrow `sed -n` range or Read with offset and limit), never a whole " +
    "file to skim it; hand a wide search to a subagent that answers with a summary rather than with file contents; and " +
    "if the task is still far from done, finish a coherent part, say plainly where it stands, and suggest continuing " +
    "in a fresh conversation.";

// Per turn (a closure per baseOptions), like the search notices: each line is said once. `read` is the transcript
// reader, swapped in tests.
export const contextBudgetHooks = (lines: readonly number[] = CONTEXT_BUDGET_LINES, read: (path: string) => Promise<number | undefined> = lastRequestTokens) => {
    let crossed = 0;
    return {
        PostToolUse: [
            {
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse" || input.agent_id !== undefined || crossed >= lines.length) {
                            return {};
                        }
                        const tokens = await read(input.transcript_path);
                        const now = tokens === undefined ? 0 : lines.filter((line) => tokens >= line).length;
                        if (tokens === undefined || now <= crossed) {
                            return {};
                        }
                        crossed = now;
                        return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: contextBudgetNotice(tokens) } };
                    },
                ],
            },
        ],
    } satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;
};

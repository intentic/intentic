/* THE MEASURING BEHIND `bench:guidance`, kept apart from the printing so it can be imported by a test: a
 * module that scanned a whole corpus on import could not be. guidance-stats.ts says what this is for and how
 * to read what it returns; this file is the arithmetic.
 *
 * SCOPE. Claude Code transcripts only. Codex, Grok, Gemini, Cursor, Pi and ACP turns keep their own history
 * elsewhere, so every share computed here is a share OF THE CLAUDE ARM.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// The PRODUCTION classifiers, not a copy of them: `walksTreeWithGrep` is the same predicate the search-hygiene
// hook fires on, so the figure quoted for SEARCH_GUIDANCE cannot drift away from the notice it argues for.
import { agentCommand } from "../src/agent/agent-installs.js";
import { walksTreeWithGrep } from "../src/agent/agent-search.js";

/* ---- the corpus ------------------------------------------------------------------------------------------
 *
 * One JSONL per session. An assistant line carries `tool_use` blocks; the matching `tool_result` arrives on a
 * later user line under the same id. THE STREAM SPLITS ONE MODEL RESPONSE ACROSS SEVERAL LINES, one block each,
 * so "how many tools did this response ask for" is a question about `requestId` and not about lines: count
 * lines and every response in the corpus looks single-call. A user line with NO tool_result on it is a real
 * prompt, and that is the only turn boundary the format has. */

interface Call {
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly model: string | undefined;
    readonly responseIndex: number;
    readonly bytes: number;
    readonly text: string;
    readonly isError: boolean;
    // Wall time the model waited. Undefined when either stamp is missing, rather than 0: a missing duration
    // must not read as a fast call once these are summed into hours.
    readonly durationMs: number | undefined;
    // The two stamps behind it, kept so a caller can measure the OTHER half of a round trip: the gap between
    // one result landing and the next call being asked for, which is the model's own thinking time.
    readonly askedAt: number | undefined;
    readonly answeredAt: number | undefined;
    readonly structuredPatch: readonly { newStart?: number; newLines?: number }[] | undefined;
}

/* As much of the line format as anything here reads. Everything is optional because a transcript is somebody
 * else's file: a line from an older CLI, a replayed line, or a shape that lands next release must skip rather
 * than throw, since one bad line would otherwise cost the whole corpus. */
interface ToolUseBlock {
    readonly type: "tool_use";
    readonly id: string;
    readonly name: string;
    readonly input?: Record<string, unknown>;
}
interface ToolResultBlock {
    readonly type: "tool_result";
    readonly tool_use_id: string;
    readonly content?: unknown;
    readonly is_error?: boolean;
}
type ContentBlock = ToolUseBlock | ToolResultBlock | { readonly type?: string };

interface TranscriptEvent {
    readonly type?: string;
    readonly uuid?: string;
    readonly requestId?: string;
    readonly timestamp?: string;
    readonly message?: { readonly id?: string; readonly model?: string; readonly content?: readonly ContentBlock[] | string };
    readonly toolUseResult?: { readonly structuredPatch?: readonly { readonly newStart?: number; readonly newLines?: number }[] };
}

const transcriptFiles = (root: string): string[] => {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                walk(path);
            } else if (entry.endsWith(".jsonl")) {
                found.push(path);
            }
        }
    };
    walk(root);
    return found;
};

// Only text is content the model read. A non-text block (an image) contributes nothing rather than a synthetic
// "[image]", which would be counted as characters the model was billed for reading.
const resultText = (content: unknown): string => {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(resultText).join("\n");
    }
    if (content !== null && typeof content === "object" && "text" in content) {
        return typeof content.text === "string" ? content.text : "";
    }
    return "";
};

// Completed calls of one session, in the order their results arrived, which is the order the model read them.
// A call whose result never arrived (a turn killed mid-flight) is skipped: there is nothing to measure, and
// counting it would inflate every denominator here.
function* readCalls(file: string): Generator<Call> {
    const pending = new Map<string, Omit<Call, "bytes" | "text" | "isError" | "durationMs" | "structuredPatch" | "answeredAt">>();
    const responseIds = new Map<string, number>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line === "") {
            continue;
        }
        let event: TranscriptEvent;
        try {
            event = JSON.parse(line) as TranscriptEvent;
        } catch {
            continue;
        }
        const blocks = event.message?.content;
        if (!Array.isArray(blocks)) {
            continue;
        }
        if (event.type === "assistant") {
            // One id per model RESPONSE. The stream splits a response across lines, so it has to come from the
            // request rather than the line: `requestId`, with `message.id` for a replayed line that lacks one.
            const key = String(event.requestId ?? event.message?.id ?? event.uuid);
            if (!responseIds.has(key)) {
                responseIds.set(key, responseIds.size);
            }
            for (const block of blocks) {
                if (block.type === "tool_use") {
                    pending.set(block.id, {
                        name: block.name,
                        input: block.input ?? {},
                        model: event.message?.model,
                        responseIndex: responseIds.get(key) ?? 0,
                        askedAt: Date.parse(event.timestamp ?? "") || undefined,
                    });
                }
            }
            continue;
        }
        if (event.type !== "user") {
            continue;
        }
        const answeredAt = Date.parse(event.timestamp ?? "") || undefined;
        for (const block of blocks) {
            if (block.type !== "tool_result") {
                continue;
            }
            const use = pending.get(block.tool_use_id);
            if (use === undefined) {
                continue;
            }
            pending.delete(block.tool_use_id);
            const text = resultText(block.content);
            const { askedAt, ...rest } = use;
            yield {
                ...rest,
                text,
                bytes: text.length,
                isError: block.is_error === true,
                askedAt,
                answeredAt,
                durationMs: askedAt !== undefined && answeredAt !== undefined ? answeredAt - askedAt : undefined,
                structuredPatch: event.toolUseResult?.structuredPatch,
            };
        }
    }
}

/* ---- accumulators ---------------------------------------------------------------------------------------- */

const median = (values: number[]): number => {
    if (values.length === 0) {
        return 0;
    }
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const percent = (part: number, whole: number): string => (whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`);
const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)}h`;
const bump = (counts: Record<string, number>, key: string, by = 1): void => {
    counts[key] = (counts[key] ?? 0) + by;
};

/* Landing just under the 120s default Bash timeout is the tell that the agent is budgeting around the harness
 * rather than waiting on anything. Counted two ways because the original figure does not say which it meant,
 * and they no longer agree: by the sleep the agent WROTE, and by how long the call actually SAT (a `sleep 60`
 * behind a slow command reaches the same place without being hand-tuned to it). */
const justUnderBashTimeout = (sleptSeconds: number, durationMs: number): { byArgument: number; byDuration: number } => ({
    byArgument: sleptSeconds >= 105 && sleptSeconds < 120 ? 1 : 0,
    byDuration: durationMs >= 105_000 && durationMs < 120_000 ? 1 : 0,
});

// A Read's byte window, so a re-read can be told from a read of somewhere else in the same file. Claude Code's
// own default cap when the model names neither bound.
const DEFAULT_READ_LIMIT = 2000;
const readRange = (input: Record<string, unknown>): [number, number] => {
    const offset = typeof input["offset"] === "number" ? input["offset"] : 1;
    const limit = typeof input["limit"] === "number" ? input["limit"] : DEFAULT_READ_LIMIT;
    return [offset, offset + limit];
};

export const guidanceStats = (root: string) => {
    const models: Record<string, number> = {};
    const tools: Record<string, number> = {};
    let sessions = 0;
    let calls = 0;
    let errors = 0;
    let toolTimeMs = 0;

    // batching
    let responses = 0;
    let singleCall = 0;
    let orientingRunCalls = 0;
    let orientingRunMs = 0;
    // How long the MODEL took to ask for the next thing, measured from the moment the previous result landed.
    // Distinct from a tool's own execution time, and the number that makes a wasted round trip expensive.
    const roundTripMs: number[] = [];

    // search
    let bash = 0;
    let bashBackground = 0;
    let treeGrep = 0;
    let ripgrep = 0;
    const grepMs: number[] = [];
    const grepBytes: number[] = [];
    const rgMs: number[] = [];
    const rgBytes: number[] = [];

    // waiting
    let sleeps = 0;
    let sleepMs = 0;
    let sleptJustUnderByArgument = 0;
    let sleptJustUnderByDuration = 0;
    let watchStarts = 0;

    // context reuse
    let reads = 0;
    const readMs: number[] = [];
    let reReads = 0;
    let worstPathReads = 0;
    const reReadClass: Record<string, number> = {};
    const reReadBytes: Record<string, number> = {};

    for (const file of transcriptFiles(root)) {
        sessions += 1;
        const readCount = new Map<string, number>();
        const written = new Map<string, { hunks: [number, number][] | undefined }>();
        // Response indices restart at 0 in every session, so they are only unique WITHIN a file. Counting them
        // in one corpus-wide map collapsed 98k responses onto 1.1k keys and reported 103 calls per response.
        let open: { size: number; orienting: boolean; ms: number } | undefined;
        // A run of consecutive single-call responses that only READ: where batching is free by construction,
        // and where the corpus says it does not happen.
        let runCalls = 0;
        let runMs = 0;
        const closeRun = (): void => {
            if (runCalls >= 3) {
                orientingRunCalls += runCalls;
                orientingRunMs += runMs;
            }
            runCalls = 0;
            runMs = 0;
        };
        // A response is judged once it is COMPLETE, on its own single call: judging it as the next call arrives
        // tested the previous response's size against the next response's tool name.
        const closeResponse = (): void => {
            if (open === undefined) {
                return;
            }
            responses += 1;
            if (open.size === 1) {
                singleCall += 1;
            }
            if (open.size === 1 && open.orienting) {
                runCalls += 1;
                runMs += open.ms;
            } else {
                closeRun();
            }
            open = undefined;
        };
        let lastResponse = -1;
        let lastAnsweredAt: number | undefined;

        for (const call of readCalls(file)) {
            calls += 1;
            bump(tools, call.name);
            if (call.model !== undefined) {
                bump(models, call.model);
            }
            if (call.isError) {
                errors += 1;
            }
            toolTimeMs += call.durationMs ?? 0;
            if (call.askedAt !== undefined && lastAnsweredAt !== undefined && call.askedAt >= lastAnsweredAt) {
                roundTripMs.push(call.askedAt - lastAnsweredAt);
            }
            lastAnsweredAt = call.answeredAt;

            // A response is "orienting" when it asked for exactly one thing and that thing only READ: a
            // Read/Grep/Glob, or a Bash the production search classifier says walks the tree. Bash is in
            // deliberately, because most orientation in this corpus IS a shell command, and a definition that
            // leaves it out measures a rarer situation than the one the guidance names.
            if (call.responseIndex !== lastResponse) {
                closeResponse();
                lastResponse = call.responseIndex;
            }
            const reads_only =
                ["Read", "Grep", "Glob", "ToolSearch", "WebFetch"].includes(call.name) ||
                (call.name === "Bash" && typeof call.input["command"] === "string" && walksTreeWithGrep(call.input["command"]));
            open =
                open === undefined
                    ? { size: 1, orienting: reads_only, ms: call.durationMs ?? 0 }
                    : { size: open.size + 1, orienting: open.orienting && reads_only, ms: open.ms + (call.durationMs ?? 0) };

            if (call.name === "mcp__watch__start") {
                watchStarts += 1;
            }

            if (call.name === "Bash" && typeof call.input["command"] === "string") {
                bash += 1;
                const command = agentCommand(call.input["command"]);
                if (call.input["run_in_background"] === true) {
                    bashBackground += 1;
                }
                if (walksTreeWithGrep(call.input["command"])) {
                    treeGrep += 1;
                    grepMs.push(call.durationMs ?? 0);
                    grepBytes.push(call.bytes);
                }
                if (/(?:^|[|;&]\s*)rg\s/.test(command)) {
                    ripgrep += 1;
                    rgMs.push(call.durationMs ?? 0);
                    rgBytes.push(call.bytes);
                }
                // `sleep N` as a step of the command, not the word inside a quoted string.
                const slept = /(?:^|[|;&]\s*|&&\s*)sleep\s+([\d.]+)/.exec(command);
                if (slept?.[1] !== undefined) {
                    sleeps += 1;
                    sleepMs += call.durationMs ?? 0;
                    const justUnder = justUnderBashTimeout(Number(slept[1]), call.durationMs ?? 0);
                    sleptJustUnderByArgument += justUnder.byArgument;
                    sleptJustUnderByDuration += justUnder.byDuration;
                }
            }

            const path = typeof call.input["file_path"] === "string" ? call.input["file_path"] : undefined;
            if ((call.name === "Edit" || call.name === "Write") && path !== undefined) {
                const patch = call.structuredPatch;
                written.set(path, {
                    hunks:
                        Array.isArray(patch) && patch.length > 0
                            ? patch.map((h) => [h.newStart ?? 1, (h.newStart ?? 1) + (h.newLines ?? 0)] as [number, number])
                            : undefined,
                });
            }
            if (call.name === "Read" && path !== undefined) {
                reads += 1;
                readMs.push(call.durationMs ?? 0);
                const seen = readCount.get(path) ?? 0;
                readCount.set(path, seen + 1);
                worstPathReads = Math.max(worstPathReads, seen + 1);
                if (seen > 0) {
                    reReads += 1;
                }
                // The decomposition that decides whether a re-read is waste. Only the last two are the thing
                // the guidance names; a read of a DIFFERENT part of a file this turn edited is ordinary work.
                const edit = written.get(path);
                if (edit !== undefined) {
                    const [start, end] = readRange(call.input);
                    const cls =
                        call.input["offset"] === undefined && call.input["limit"] === undefined
                            ? "full re-read of a file we edited"
                            : edit.hunks === undefined
                              ? "ranged read after a whole-file Write"
                              : edit.hunks.some(([hs, he]) => start < he && hs < end)
                                ? "ranged read OVERLAPPING our edit"
                                : "ranged read elsewhere in the file";
                    bump(reReadClass, cls);
                    bump(reReadBytes, cls, call.bytes);
                    written.delete(path);
                }
            }
        }
        // The session's last response is complete once its file is: without this it is never counted, and a
        // run it would have extended is never closed.
        closeResponse();
        closeRun();
    }

    const confirming = (reReadClass["ranged read OVERLAPPING our edit"] ?? 0) + (reReadClass["full re-read of a file we edited"] ?? 0);
    const confirmingBytes = (reReadBytes["ranged read OVERLAPPING our edit"] ?? 0) + (reReadBytes["full re-read of a file we edited"] ?? 0);

    return {
        root,
        corpus: { sessions, calls, responses, errors, errorRate: percent(errors, calls), toolTime: hours(toolTimeMs), models },
        BATCHING_GUIDANCE: {
            claimed: "104,046 calls in 90,835 responses; 1.15/response; 87.3% single-call; 15,690 calls in orienting runs, 37.2h",
            callsPerResponse: (calls / Math.max(responses, 1)).toFixed(2),
            singleCall: percent(singleCall, responses),
            callsInOrientingRuns: orientingRunCalls,
            orientingRunShare: percent(orientingRunCalls, calls),
            orientingRunLatency: hours(orientingRunMs),
        },
        SEARCH_GUIDANCE: {
            // The block's latency/bytes figures came from REPLAYING 60 patterns against this repo, which is a
            // different measurement from anything a transcript holds: what the corpus stores is the output the
            // model was shown, already trimmed by the output filter. Only the call counts are checkable here.
            claimed: "42% of Bash shells out to grep (25,445 calls) vs 1.1% rg (670)",
            bashCalls: bash,
            treeWalkingGrep: `${treeGrep} (${percent(treeGrep, bash)})`,
            ripgrep: `${ripgrep} (${percent(ripgrep, bash)})`,
            medianSeenAfterFiltering: `grep ${median(grepMs)}ms / ${(median(grepBytes) / 1000).toFixed(1)}KB, rg ${median(rgMs)}ms / ${(median(rgBytes) / 1000).toFixed(1)}KB`,
        },
        WAITING_GUIDANCE: {
            claimed: "sleep cost 35.2h from 2,622 commands, a third of all tool time; 935 at 109-110s; run_in_background 1.5%; watch 38 calls",
            sleepCommands: sleeps,
            sleepCost: hours(sleepMs),
            shareOfToolTime: percent(sleepMs, toolTimeMs),
            sleptJustUnderByArgument,
            sleptJustUnderByDuration,
            runInBackground: percent(bashBackground, bash),
            watchStarts,
        },
        CONTEXT_REUSE_GUIDANCE: {
            claimed: "23.9% of Reads re-read a path (2,450 calls); one file opened 33 times; a Read-shaped response costs ~9s",
            reads,
            reReads: `${reReads} (${percent(reReads, reads)})`,
            worstPathReads,
            // Two different costs, and the block's "~9s" is the second one. A Read EXECUTES in milliseconds;
            // what a wasted re-read really buys is the round trip, the model's own time composing the next ask.
            readExecutionMedianMs: median(readMs),
            modelRoundTripMedianMs: median(roundTripMs),
            // The half the block's closing sentence actually names, split out from the re-reads that are just
            // the agent paging through a file it happens to have edited.
            confirmingReadBacks: `${confirming} calls, ~${Math.round(confirmingBytes / 4).toLocaleString()} tok`,
            breakdown: reReadClass,
        },
        CHECKLIST_GUIDANCE: {
            claimed: "TaskCreate called zero times across a corpus of sandbox turns",
            TaskCreate: tools["TaskCreate"] ?? 0,
            TaskUpdate: tools["TaskUpdate"] ?? 0,
            TaskList: tools["TaskList"] ?? 0,
        },
    };
};

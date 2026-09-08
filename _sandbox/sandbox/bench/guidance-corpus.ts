// The measuring behind bench:guidance, kept separate from printing so a test can import it; guidance-stats.ts explains
// what this is for. Claude Code transcripts only: every share here is a share of the Claude arm.

import { readFileSync } from "node:fs";
import { agentCommand } from "../src/agent/providers/agent-installs.js";
import { walksTreeWithGrep } from "../src/agent/verification/agent-search.js";
import { transcriptFiles } from "./transcripts.js";

// One JSONL per session. A response can split across several lines (one tool_use block per line, matched to its
// tool_result by id), so counting lines undercounts calls per response; a user line with no tool_result is the real
// turn boundary.

interface Call {
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly model: string | undefined;
    readonly responseIndex: number;
    readonly bytes: number;
    readonly text: string;
    readonly isError: boolean;
    // Wall time the model waited; undefined, not 0, when a stamp is missing, so it doesn't read as fast once summed.
    readonly durationMs: number | undefined;
    // The two stamps behind duration, so a caller can measure the model's own thinking time between calls.
    readonly askedAt: number | undefined;
    readonly answeredAt: number | undefined;
    readonly structuredPatch: readonly { newStart?: number; newLines?: number }[] | undefined;
}

// As much of the line format as anything here reads; every field is optional since a transcript is somebody else's
// file, and one bad line must skip rather than cost the whole corpus.
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

// Only text counts as content the model read; a non-text block (an image) contributes nothing rather than a synthetic
// count.
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

// Completed calls of one session, in result-arrival order; a call whose result never arrived (killed mid-flight) is
// skipped rather than inflating every denominator.
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
            // One id per model response (`requestId`, or `message.id` for a replay), since a response can span lines.
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

// Accumulators.

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

// Landing just under the 120s default Bash timeout signals budgeting around the harness, not real work; counted both by
// the sleep argument and by actual duration, since they can disagree.
const justUnderBashTimeout = (sleptSeconds: number, durationMs: number): { byArgument: number; byDuration: number } => ({
    byArgument: sleptSeconds >= 105 && sleptSeconds < 120 ? 1 : 0,
    byDuration: durationMs >= 105_000 && durationMs < 120_000 ? 1 : 0,
});

// A turn sent after a deferred tool that no longer exists; the only trace is this sentence in a tool_result.
const TOOL_SEARCH_MISS = "No matching deferred tools found";
const CHECKLIST_VERB = /^Task(Create|Get|Update|List)$/;

// Which bucket a miss falls in: "checklist" named only checklist verbs (the harness's own doing), "other" is the model
// guessing at a loaded-not-deferred name, "" is everything else.
const deferredMissKind = (call: Call): string => {
    if (call.name !== "ToolSearch" || !call.text.includes(TOOL_SEARCH_MISS)) {
        return "";
    }
    const query = typeof call.input["query"] === "string" ? call.input["query"] : "";
    // A keyword query ("+browser navigate") names no tool at all, so it can only be the second kind.
    const asked = query.startsWith("select:")
        ? query
              .slice("select:".length)
              .split(",")
              .map((name) => name.trim())
              .filter((name) => name !== "")
        : [];
    return asked.length > 0 && asked.every((name) => CHECKLIST_VERB.test(name)) ? "checklist" : "other";
};

// Separates a checklist the model declined from one the CLI stopped shipping; the second line is model noise, kept so a
// rise in the first can't be waved away.
const emptySearchFigures = (tools: Record<string, number>, misses: Record<string, number>): Record<string, string | number> => ({
    deadChecklistSearches: `${misses["checklist"] ?? 0} of ${tools["ToolSearch"] ?? 0} ToolSearch calls`,
    otherEmptySearches: misses["other"] ?? 0,
});

// A Read's byte window, telling a re-read from a read elsewhere; the CLI's own default when no bound is named.
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
    // How the model took to ask for the next thing, from the last result landing, not a tool's own execution time.
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

    // checklist: ToolSearch calls that came back empty, split by whose fault the emptiness is.
    const deferredMisses: Record<string, number> = {};

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
        // Response indices restart at 0 per session, so they're unique only within a file, not the whole corpus.
        let open: { size: number; orienting: boolean; ms: number } | undefined;
        // A run of consecutive single-call responses that only read: where batching is free by construction.
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
        // A response is judged complete on its own single call; judging it as the next call arrives would compare
        // against the wrong response.
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

            // "Orienting": exactly one call, and it only reads (Read/Grep/Glob, or a Bash that walks the tree).
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

            bump(deferredMisses, deferredMissKind(call));

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
                // Which re-read is waste: overlapping or re-reading an edited file; elsewhere in the file is ordinary
                // work.
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
        // The session's last response closes with its file, or it's never counted and its run never closes.
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
            // Latency and byte figures came from replaying patterns against this repo; only call counts are checkable
            // here.
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
            // Two different costs: the block's "~9s" is the round trip, the model's thinking time, not a Read's
            // execution.
            readExecutionMedianMs: median(readMs),
            modelRoundTripMedianMs: median(roundTripMs),
            // The half the block's closing sentence names, split from re-reads that just page through an edited file.
            confirmingReadBacks: `${confirming} calls, ~${Math.round(confirmingBytes / 4).toLocaleString()} tok`,
            breakdown: reReadClass,
        },
        CHECKLIST_GUIDANCE: {
            claimed: "TaskCreate called zero times across a corpus of sandbox turns",
            TaskCreate: tools["TaskCreate"] ?? 0,
            TaskUpdate: tools["TaskUpdate"] ?? 0,
            TaskList: tools["TaskList"] ?? 0,
            ...emptySearchFigures(tools, deferredMisses),
        },
    };
};

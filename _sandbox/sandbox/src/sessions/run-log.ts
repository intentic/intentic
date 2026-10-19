import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { parseJsonOr } from "@intentic/base/json";
import { type TranscriptPatch, TranscriptPatchSchema, type TranscriptRow, TranscriptRowSchema, type TranscriptTool } from "@intentic/sandbox-contract/events/transcript";
import { applyTranscriptPatch } from "@intentic/sandbox-contract/transcript-fold";
import { z } from "zod";

// A RUNNING TURN'S ROWS, ON DISK AS THEY ARE DRAWN. The record (transcript-record.ts) takes a turn once it settles; until
// then its rows were the live fold's alone, so a daemon that died mid-turn left a Codex, Cursor or Gemini turn's record
// with nothing but its prompt, and a Claude one with what the CLI's own session happened to hold (2026-10-19). This log
// is the run's opening rows, then every patch it published, one JSON line each, in the conversation's own unit on the
// history volume: a boot folds it back into the rows any window was showing (applyTranscriptPatch, the clients' own
// reducer), whatever runtime ran the turn. One per conversation, since a conversation runs one turn at a time.
//
// - Written in batches, a second apart and at once when a card parks the turn, each batch synced before the next.
// - A card still running is logged without its output: a streaming command would otherwise write its whole output again
//   every second. The output it settles with is logged whole.
// - Removed once the settled turn is on the record. A record that could not be written keeps the log under its run's
//   name (`unrecorded-<run>.jsonl`), recorded by whatever next writes this conversation's record, ahead of its own rows.
// - A write that fails costs the log, never the turn: it is said once and the run goes on unlogged.

const RUN_LOG = "running.jsonl";
const UNRECORDED = "unrecorded-";

/** How long a run's patches wait before they are written, unless a card parks the turn first. */
const RUN_LOG_FLUSH_MS = 1_000;

// What the log opens with: the run it is, when it started, and the rows it opened on.
const HeadSchema = z.object({ run: z.string(), startedAt: z.number(), rows: z.array(TranscriptRowSchema) });
export type RunLogHead = z.infer<typeof HeadSchema>;
const HeadLineSchema = z.object({ head: HeadSchema });

export interface RunLog {
    // What the run just drew, written within the flush interval.
    readonly append: (patches: readonly TranscriptPatch[]) => void;
    // Everything queued, written and synced now.
    readonly flush: () => Promise<void>;
    // The run is over: the log goes once its rows are on the record, or is kept for the next writer if they are not.
    readonly close: (recorded: boolean) => Promise<void>;
}

/** A run that keeps no log: one whose conversation has nowhere on disk to keep it. */
export const NO_RUN_LOG: RunLog = { append: () => undefined, flush: async () => undefined, close: async () => undefined };

const TERMINAL: ReadonlySet<TranscriptTool["status"]> = new Set(["completed", "failed"]);

// A batch as it is written: a card's updates folded into its latest, a row's prose and reasoning into one piece each,
// and a card still running without its output.
const compacted = (patches: readonly TranscriptPatch[]): TranscriptPatch[] => {
    const out: TranscriptPatch[] = [];
    for (const patch of patches) {
        const last = out.at(-1);
        if (patch.op === "tool") {
            const { content: _output, ...running } = patch.tool;
            const lean: TranscriptPatch = TERMINAL.has(patch.tool.status) ? patch : { ...patch, tool: running };
            const sameCard = last?.op === "tool" && last.index === patch.index && last.tool.id === patch.tool.id && last.parent === patch.parent;
            if (sameCard) {
                out[out.length - 1] = lean;
            } else {
                out.push(lean);
            }
            continue;
        }
        if ((patch.op === "text" || patch.op === "thinking") && last?.op === patch.op && last.index === patch.index) {
            out[out.length - 1] = { ...last, text: `${last.text}${patch.text}` };
            continue;
        }
        out.push(patch);
    }
    return out;
};

const lineOf = (value: { readonly head: RunLogHead } | TranscriptPatch): string => `${JSON.stringify(value)}\n`;

/**
 * Opens a run's log in `dir` (its conversation's unit), replacing any earlier run's: the conversation runs this one now.
 * `warn` hears the first write that failed, after which the run goes on unlogged, and a log that could not be cleared.
 */
export const openRunLog = (
    dir: string,
    head: RunLogHead,
    warn: (message: string, error: Error) => void,
    flushMs: number = RUN_LOG_FLUSH_MS,
): RunLog => {
    const path = join(dir, RUN_LOG);
    let failed = false;
    const fail = (error: Error): void => {
        if (!failed) {
            failed = true;
            warn("run log: a write failed, the rest of this run goes unlogged", error);
        }
    };
    let queued: TranscriptPatch[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Whether the file was ever made: one that never was has nothing to take away or keep.
    let opened = false;
    // Each write opens the file, appends, syncs and closes it again: a run parked on a card for days holds no handle.
    const put = async (text: string): Promise<void> => {
        if (!opened) {
            await mkdir(dir, { recursive: true });
        }
        const file = await open(path, opened ? "a" : "w");
        try {
            await file.write(text);
            await file.datasync();
        } finally {
            await file.close();
        }
        opened = true;
    };
    // One write after another, so the file is one sequence of lines and never two interleaved.
    let chain: Promise<void> = Promise.resolve();
    const step = (text: string): Promise<void> => {
        const run = async (): Promise<void> => {
            if (failed) {
                return;
            }
            try {
                await put(text);
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
            }
        };
        chain = chain.then(run);
        return chain;
    };
    void step(lineOf({ head }));
    const write = async (): Promise<void> => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        const batch = compacted(queued);
        queued = [];
        await (batch.length === 0 ? chain : step(batch.map(lineOf).join("")));
    };
    return {
        append: (patches) => {
            if (failed || patches.length === 0) {
                return;
            }
            queued.push(...patches);
            if (timer === undefined) {
                timer = setTimeout(() => void write(), flushMs);
                timer.unref();
            }
        },
        flush: write,
        close: async (recorded) => {
            await write();
            // A log cut short by a failed write holds part of the run: taken away with the rest, never kept as its record.
            if (!opened || (failed && !recorded)) {
                return;
            }
            await (recorded ? rm(path, { force: true }) : rename(path, join(dir, `${UNRECORDED}${head.run}.jsonl`))).catch((error: Error) =>
                warn(recorded ? "run log: not removed after the record took the turn" : "run log: not kept for the record that failed", error),
            );
        },
    };
};

// One log read back: its head, then every patch until the first line that does not read, which is where a crash cut it
// mid-write. Undefined when there is no log, or its head does not read.
const readLog = async (path: string): Promise<RunLogHead | undefined> => {
    const text = await readFile(path, "utf8").catch(undefinedIfMissing);
    if (text === undefined) {
        return undefined;
    }
    const [first, ...lines] = text.split("\n");
    // A line that does not parse reads as undefined: the empty last line, or one a crash cut mid-write.
    const head = HeadLineSchema.safeParse(parseJsonOr(first ?? "", undefined));
    if (!head.success) {
        return undefined;
    }
    let rows: readonly TranscriptRow[] = head.data.head.rows;
    for (const line of lines) {
        const patch = TranscriptPatchSchema.safeParse(parseJsonOr(line, undefined));
        if (!patch.success) {
            break;
        }
        rows = applyTranscriptPatch(rows, patch.data);
    }
    return { ...head.data.head, rows: [...rows] };
};

/** The rows a conversation's running log had drawn, when it is the log of run `run`: what a boot records of a cut turn. */
export const readRunLog = async (dir: string, run: string | undefined): Promise<RunLogHead | undefined> => {
    if (run === undefined) {
        return undefined;
    }
    const read = await readLog(join(dir, RUN_LOG));
    return read?.run === run ? read : undefined;
};

/** Takes a conversation's running log away, once what it held is on the record. */
export const removeRunLog = async (dir: string, run: string | undefined): Promise<void> => {
    if (run !== undefined && (await readRunLog(dir, run)) !== undefined) {
        await rm(join(dir, RUN_LOG), { force: true });
    }
};

/** Every run of this conversation whose settled rows never reached the record, oldest first, with what each drew. */
export const unrecordedRuns = async (dir: string): Promise<{ readonly head: RunLogHead; readonly remove: () => Promise<void> }[]> => {
    const names = ((await readdir(dir).catch(undefinedIfMissing)) ?? []).filter((name) => name.startsWith(UNRECORDED) && name.endsWith(".jsonl"));
    const read = await Promise.all(names.map(async (name) => ({ name, head: await readLog(join(dir, name)) })));
    return read
        .flatMap(({ name, head }) => (head === undefined ? [] : [{ head, remove: () => rm(join(dir, name), { force: true }) }]))
        .toSorted((left, right) => left.head.startedAt - right.head.startedAt);
};

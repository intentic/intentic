import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../../../store/evolution/documents.js";
import { openDocument } from "../../../store/open-document.js";
import { createPeakWatch } from "./peak-watch.js";
import { watchUnqueuedPeaks } from "./unqueued-peaks.js";

/* WHAT EACH HEAVY COMMAND TOOK AT ITS PEAK, the last few times it ran in this sandbox (2026-11-22, the shinobi-society
   audit). The memory gate prices the next run of the same command at least at that, with a margin
   (@intentic/constants memory-room `learnedCostBytes`), so neither a rule's size nor a too-small default underprices a
   command already measured heavier: `cargo test -p integra-render` was priced at 512 MiB and peaked at 7 to 13.5 GB.

   A command is the key memory-room sends (@intentic/constants heavy/command-peaks.mjs `commandSignature`: the rule, the
   repository and folder, the program and what decides its size). Each keeps its last SAMPLES_KEPT peaks from the last
   two weeks, and is priced by the largest: a command made lighter stops being priced by its old peak within two weeks or
   five runs. Kept on /history, at most MAX_COMMANDS commands, the one run longest ago going first. Measured by
   peak-watch.ts from the admission memory-room asked for until the command exits. (2026-11-25) An agent's whole line that
   grew heavy outside the queue is kept here too, under the rule `learned` (unqueued-peaks.ts), and queues its next run. */

const MIB = 1024 ** 2;
const SAMPLES_KEPT = 5;
const SAMPLE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const MAX_COMMANDS = 300;

const SampleSchema = z.object({ mib: z.number().int().nonnegative(), at: z.number().int().nonnegative() });
const CommandSchema = z.object({ key: z.string().min(1), command: z.string(), samples: z.array(SampleSchema) });
const FileSchema = z.object({ commands: z.array(CommandSchema).default([]) });
type Sample = z.infer<typeof SampleSchema>;

export const commandPeaksDocument = defineDocument({
    root: "history",
    path: "command-peaks.json",
    portability: "carry",
    schema: FileSchema,
});

export interface LearnedPeak {
    // The words the command is named by, as the wait line quotes them.
    readonly command: string;
    // The largest of its recent peaks, and how many recent runs that is of.
    readonly peakBytes: number;
    readonly runs: number;
}

export interface PeakRecords {
    // What the command `key` names took at its peak lately; undefined for one not measured in two weeks.
    readonly learned: (key: string) => Promise<LearnedPeak | undefined>;
    readonly record: (key: string, command: string, peakBytes: number) => Promise<void>;
}

const recent = (samples: readonly Sample[], now: number): Sample[] => samples.filter((sample) => now - sample.at <= SAMPLE_MAX_AGE_MS);
const latest = (samples: readonly Sample[]): number => Math.max(0, ...samples.map((sample) => sample.at));

export const fileCommandPeaks = (historyRoot: string, now: () => number = Date.now): PeakRecords => {
    // Unreadable peaks are relearned in a run each; the document layer keeps the old file before replacing it.
    const file = openDocument(commandPeaksDocument, join(historyRoot, commandPeaksDocument.path), { fallback: () => ({ commands: [] }) });
    return {
        learned: async (key) => {
            const found = (await file.read()).commands.find((entry) => entry.key === key);
            const samples = recent(found?.samples ?? [], now());
            return found === undefined || samples.length === 0
                ? undefined
                : { command: found.command, peakBytes: Math.max(...samples.map((sample) => sample.mib)) * MIB, runs: samples.length };
        },
        record: async (key, command, peakBytes) => {
            const at = now();
            await file.update((current) => {
                const previous = current.commands.find((entry) => entry.key === key);
                const samples = [...recent(previous?.samples ?? [], at), { mib: Math.max(1, Math.round(peakBytes / MIB)), at }].slice(-SAMPLES_KEPT);
                const others = current.commands.flatMap((entry) => {
                    const kept = recent(entry.samples, at);
                    return entry.key === key || kept.length === 0 ? [] : [{ ...entry, samples: kept }];
                });
                const commands = [{ key, command, samples }, ...others].toSorted((left, right) => latest(right.samples) - latest(left.samples));
                return { commands: commands.slice(0, MAX_COMMANDS) };
            });
        },
    };
};

/**
 * The learned peaks and their measurement, as the room socket takes them (workload/room-socket.ts CommandPeaks), with
 * the watch on agent lines that grow heavy outside the queue (unqueued-peaks.ts), which records beside them; `stop`, as
 * the socket closes, ends both.
 */
export const commandPeaks = (historyRoot: string): PeakRecords & ReturnType<typeof createPeakWatch> => {
    const records = fileCommandPeaks(historyRoot);
    const queued = createPeakWatch({ record: records.record });
    const unqueued = watchUnqueuedPeaks({ record: records.record });
    return {
        ...queued,
        learned: records.learned,
        record: records.record,
        stop: () => {
            queued.stop();
            unqueued.stop();
        },
    };
};

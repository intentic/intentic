import { mapPool } from "@intentic/base/async";
import { LEARNED_MIN_BYTES } from "@intentic/constants/memory-room";
import { SIGNATURE_FILE } from "./learned-lines.js";
import { z } from "zod";
import { type ReadText, readText } from "../cgroup.js";
import { procUnits, type ScannedProcess, scanProcesses } from "../process-scan.js";

/* WHAT AN AGENT'S COMMAND TOOK THAT THE QUEUE NEVER PRICED (2026-11-25, the shinobi-society audit). In a burst of 15
   agents the heavy processes the memory gate never saw were the ones no rule names: a `python3` at 3.5 GiB, the
   repository's own `integra` / `integra-assets` binaries at 2.4 GiB, a game at 1.4 GiB, each started by an agent's own
   Bash line and filed as role `other`, priced at nothing. Interpreter shims catch only a project's declared classes, and
   a native binary run by path no shim catches at all.

   Every agent command runs as `bash <run dir>/runner` in a tmux pane, leading a session everything it starts keeps
   (process-scan.ts `runDir`), and the Bash hook writes the line's signature beside it (`signature`: @intentic/constants
   heavy/command-peaks.mjs `lineSignature`, under the rule `learned`). Every SAMPLE_MS this sums, per runner, the resident
   memory and swap of the processes in its session the queue does not already cover (process-scan.ts `queued`: a program
   the queue judged, and everything under a slot it took, is priced and measured by peak-watch.ts), and keeps the peak.
   When the runner goes, a peak of LEARNED_MIN_BYTES or more is recorded under the line's signature in the queued peaks'
   own file (command-peaks.ts), and the next run of the same line queues at that price (learned-lines.ts). A
   lighter run records nothing: once the line queues, peak-watch measures every run of it, light ones included, and a line
   whose recent runs all stayed under the bar stops queueing.

   Sampled, not traced: a peak shorter than SAMPLE_MS can be missed, and pages shared between members count once per
   member, so the figure errs high. Nothing here is on any command's path: a read that fails measures nothing. */

const SAMPLE_MS = 3_000;
const KIB = 1024;
// procfs reads in flight at once, as the shared process scan reads them.
const READ_CONCURRENCY = 8;

const SignatureSchema = z.object({ key: z.string().min(1).max(600), command: z.string().min(1).max(600) });
type Signature = z.infer<typeof SignatureSchema>;


interface Tracked {
    // Undefined for a run whose line names no command (or was written by no agent hook): watched for nothing.
    readonly signature: Signature | undefined;
    peakBytes: number;
}

export interface UnqueuedPeaksDeps {
    readonly record: (key: string, command: string, peakBytes: number) => Promise<void>;
    readonly scan?: () => Promise<readonly ScannedProcess[]>;
    readonly readText?: ReadText;
    readonly pageBytes?: () => Promise<number>;
    // 0 takes no timed looks: only `look` does.
    readonly sampleMs?: number;
}

export interface UnqueuedPeaks {
    // One look now, as the timer takes them.
    readonly look: () => Promise<void>;
    readonly stop: () => void;
}

const signatureOf = (text: string | undefined): Signature | undefined => {
    if (text === undefined) {
        return undefined;
    }
    try {
        return SignatureSchema.safeParse(JSON.parse(text)).data;
    } catch {
        // allow(silent-catch): a signature torn or never written names no line; its run is not measured
        return undefined;
    }
};

// A process's swapped-out memory, from its status; 0 where it cannot be read.
const swapBytes = async (read: ReadText, pid: number): Promise<number> => {
    const kib = Number(/^VmSwap:\s+(\d+)\s+kB$/mu.exec((await read(`/proc/${pid}/status`)) ?? "")?.[1] ?? 0);
    return Number.isFinite(kib) ? kib * KIB : 0;
};

/** What each runner's unqueued processes hold now, by run dir: resident memory and swap. */
export const unqueuedBytes = async (scanned: readonly ScannedProcess[], read: ReadText, pageBytes: number): Promise<Map<string, number>> => {
    const byRun = new Map<string, number>();
    const members = scanned.flatMap((entry) => {
        if (entry.runDir === undefined) {
            return [];
        }
        byRun.set(entry.runDir, byRun.get(entry.runDir) ?? 0);
        return entry.queued === true ? [] : [{ run: entry.runDir, pid: entry.pid, rssPages: entry.rssPages ?? 0 }];
    });
    await mapPool(members, READ_CONCURRENCY, async ({ run, pid, rssPages }) => {
        const bytes = rssPages * pageBytes + (await swapBytes(read, pid));
        byRun.set(run, (byRun.get(run) ?? 0) + bytes);
    });
    return byRun;
};

export const watchUnqueuedPeaks = ({
    record,
    scan = () => scanProcesses(process.pid),
    readText: read = readText,
    pageBytes = async () => (await procUnits()).pageBytes,
    sampleMs = SAMPLE_MS,
}: UnqueuedPeaksDeps): UnqueuedPeaks => {
    const runs = new Map<string, Tracked>();
    let looking: Promise<void> | undefined;

    // A run that went is let go, and its peak recorded where it was heavy and its line has a name.
    const finish = async (dir: string, run: Tracked): Promise<void> => {
        runs.delete(dir);
        if (run.signature !== undefined && run.peakBytes >= LEARNED_MIN_BYTES) {
            // allow(silent-catch): a peak that cannot be written is a run the next one measures again
            await record(run.signature.key, run.signature.command, run.peakBytes).catch(() => undefined);
        }
    };

    const lookNow = async (): Promise<void> => {
        const now = await unqueuedBytes(await scan(), read, await pageBytes());
        for (const [dir, bytes] of now) {
            let run = runs.get(dir);
            if (run === undefined) {
                // Read once, while the runner lives: tmux-run removes its dir once the command finished.
                run = { signature: signatureOf(await read(`${dir}/${SIGNATURE_FILE}`)), peakBytes: 0 };
                runs.set(dir, run);
            }
            run.peakBytes = Math.max(run.peakBytes, bytes);
        }
        await Promise.all([...runs].flatMap(([dir, run]) => (now.has(dir) ? [] : [finish(dir, run)])));
    };

    const look = (): Promise<void> =>
        (looking ??= lookNow()
            // allow(silent-catch): a look that fails measures nothing this time; the next one reads everything again
            .catch(() => undefined)
            .finally(() => {
                looking = undefined;
            }));

    const timer = sampleMs > 0 ? setInterval(() => void look(), sampleMs) : undefined;
    timer?.unref();
    return {
        look,
        stop: () => {
            clearInterval(timer);
            runs.clear();
        },
    };
};

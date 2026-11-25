import { type HeavyCommands, queueArgs } from "@intentic/constants/heavy-rules";
import { LEARNED_MIN_BYTES, LEARNED_RULE, learnedCostBytes, lineSignature, peakWords } from "@intentic/constants/memory-room";
import { shellQuote } from "@intentic/sandbox-run/quote";

/* AN AGENT'S LINE THAT GREW HEAVY OUTSIDE THE QUEUE TAKES ITS TURN THE NEXT TIME (2026-11-25, the shinobi-society
   audit). The memory gate prices only what reaches it, and a `python3 tools/gen.py` at 3.5 GiB or a repository's own
   binary run by path reaches it through no rule: it started beside everything else, priced at nothing. The daemon
   measures what each agent line's unqueued processes held (system/resources/queue/unqueued-peaks.ts) and keeps a line
   that peaked at LEARNED_MIN_BYTES or more under its signature (`learned @repo/dir: words`, @intentic/constants
   heavy/command-peaks.mjs `lineSignature`, so every worktree of a repository shares it). The next time an agent runs the
   same line, the Bash hook (agent/tools/agent-terminals.ts) runs it behind queue-run: a pool of its own, the memory gate
   asked for the room it took (`--key`/`--command`, so the room socket prices it by that peak with its margin and
   peak-watch.ts measures this run again under the same key), and one line saying why. Once its recent runs all stayed
   under the bar it runs as before.

   A background job holds its slot for as long as it runs, so jobs take a pool of their own: a dev server learned heavy
   never keeps a foreground line from its turn. Every failure here (no queue-run, the peaks unreadable, a line that names
   nothing) runs the line as it would run without this. */

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
// How many learned lines run at once, foreground and as background jobs.
const LEARNED_LIMIT = 2;
const LEARNED_JOB_LIMIT = 4;

// The file in an agent command's run dir its signature is written to, and read from by the daemon's unqueued peaks.
export const SIGNATURE_FILE = "signature";

export interface LearnedSignature {
    readonly key: string;
    readonly command: string;
}

// What the gate learned of each command (system/resources/queue/command-peaks.ts PeakRecords["learned"]).
export interface LearnedPeaks {
    readonly learned: (key: string) => Promise<{ readonly command: string; readonly peakBytes: number; readonly runs: number } | undefined>;
}

/** The signature an agent's line is measured and queued under, or undefined for one that names no command. */
export const learnedSignatureOf = (command: string, cwd: string | undefined): LearnedSignature | undefined => {
    try {
        return lineSignature(command, cwd);
    } catch {
        // allow(silent-catch): a line that cannot be named is neither measured nor queued; it runs as it would anyway
        return undefined;
    }
};

export interface LearnedQueueOptions {
    readonly peaks: LearnedPeaks | undefined;
    readonly signature: LearnedSignature | undefined;
    // The heavy table the line runs under; undefined where it could not be read.
    readonly heavy: HeavyCommands | undefined;
    // bin/queue-run, where it is installed and on.
    readonly queueRun: string | undefined;
    readonly background: boolean;
}

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * The `queue-run … -- ` a learned heavy line runs behind, ending in a space, or "" for a line that runs as it is: one
 * never learned, learned under the bar, or anything that could not be read.
 */
export const learnedQueuePrefix = async ({ peaks, signature, heavy, queueRun, background }: LearnedQueueOptions): Promise<string> => {
    if (peaks === undefined || signature === undefined || heavy === undefined || queueRun === undefined || !heavy.queue) {
        return "";
    }
    try {
        const learned = await peaks.learned(signature.key);
        if (learned === undefined || !(learned.peakBytes >= LEARNED_MIN_BYTES)) {
            return "";
        }
        // The gate is asked for the peak itself; the room socket prices it at that with the margin and says so
        // (`priced`), and a gate with no daemon behind it holds the peak.
        const peakMiB = Math.ceil(learned.peakBytes / MIB);
        const pool = background ? `${LEARNED_RULE}-jobs` : LEARNED_RULE;
        const match = { id: LEARNED_RULE, pool, limit: background ? LEARNED_JOB_LIMIT : LEARNED_LIMIT, maxHold: 0, onDeadline: "run" as const };
        const note = `${peakWords({ ...learned, bytes: learned.peakBytes })}, so it takes its turn with this sandbox's heavy commands, priced at ${gib(learnedCostBytes(peakMiB * MIB, learned.peakBytes, undefined))}.`;
        const flags = [...queueArgs(match, heavy), "--size", `${String(peakMiB)}m`, "--key", signature.key, "--command", signature.command, "--note", note];
        return `${[queueRun, ...flags, "--"].map((word) => shellQuote(word)).join(" ")} `;
    } catch {
        // allow(silent-catch): peaks that cannot be read leave the line as it would run without them
        return "";
    }
};

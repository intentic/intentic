import { statSync } from "node:fs";
import { sleep } from "@intentic/base/async";
import { opt } from "../../../opt.js";
import { type BackgroundJob, type Holders, jobCommandLine, jobFinished, jobHandle, jobOutputPath, JOBS, OUTPUT_TAIL_BYTES } from "./background-jobs.js";
import { inputWaitAt } from "./input-wait-follow.js";
import { MEMORY_KILL_FILE, OUTPUT_FILE, STATUS_FILE, STOP_REASON_FILE } from "./job-files.js";
import { settleMemoryKills } from "./memory-kills.js";
import { readRunFile } from "./run-files.js";
import { fileTail, redirectedOutput } from "./job-redirects.js";

// What a job's reader is handed (`wait`, the work-wait door): its exit, the tail of what it printed, how long it has been
// quiet, and the prompt it sits at, if any. Split from background-jobs.ts, which holds the jobs themselves.

// Empty when the file cannot be read.
// Through run-files.ts, never a link: what this returns is handed to the agent as its job's output.
const tailOf = async (job: BackgroundJob, name: string, bytes: number): Promise<string> => {
    try {
        return readRunFile(job.dir, name, bytes).text;
    } catch {
        // allow(silent-catch): a capture not yet written, already swept or refused as a link has nothing this may show, which the report reads as empty.
        return "";
    }
};

export interface JobReport {
    readonly id: string;
    readonly command: string;
    // Undefined while it runs, or when the status is not a number.
    readonly exitCode: number | undefined;
    readonly running: boolean;
    readonly outputTail: string;
    readonly outputFile: string;
    // While it runs: how long since it last printed anything, so an unchanged tail reads as the silence it is.
    readonly quietForSeconds?: number;
    // While it runs with its output sent to a file of its own (`cmd > log 2>&1`, job-redirects.ts): that file, which
    // outputTail and quietForSeconds were then read from instead of the empty or stale capture.
    readonly outputTailFrom?: string;
    // While it sits at a prompt nobody will answer (input-wait.ts): the process waiting, and for how long.
    readonly waitingForInput?: { readonly program: string; readonly pid: number; readonly forSeconds: number };
    // Once it ended because something in it was killed for memory (memory-kills.ts): what, how big, by whom and why.
    readonly killedForMemory?: string;
    // Once something other than the agent or the person stopped it (Claude Code's background time limit): what and
    // after how long (job-stop-reasons.ts), so its 143 is not read as a crash.
    readonly stoppedBecause?: string;
}

// When the capture last grew; the start when it never printed, undefined once the tmp sweep took it.
const capturedAt = (job: BackgroundJob): number | undefined => {
    try {
        return Math.max(job.startedAt, statSync(jobOutputPath(job)).mtimeMs);
    } catch {
        // allow(silent-catch): a capture the tmp sweep already took has no silence to measure.
        return undefined;
    }
};

// A capture quiet this long (or empty) has its processes' own output files looked for (job-redirects.ts): a job that
// prints to its pane is never charged the /proc walk.
const REDIRECT_LOOK_MS = 15_000;

// What a running job printed and when it last did: from its capture, or from the file its processes write to when that
// moved more recently than the capture (an empty capture never moved).
const runningOutput = async (job: BackgroundJob, now: number, procRoot: string) => {
    const tail = await tailOf(job, OUTPUT_FILE, OUTPUT_TAIL_BYTES);
    const at = capturedAt(job);
    const quietFor = (since: number): number => Math.max(0, Math.round((now - since) / 1000));
    if (tail === "" || at === undefined || now - at >= REDIRECT_LOOK_MS) {
        const redirect = await redirectedOutput(job.dir, procRoot);
        if (redirect !== undefined && (tail === "" || at === undefined || redirect.mtimeMs > at)) {
            return { tail: await fileTail(redirect.path, OUTPUT_TAIL_BYTES), quiet: quietFor(Math.max(job.startedAt, redirect.mtimeMs)), from: redirect.path };
        }
    }
    return { tail, quiet: at === undefined ? undefined : quietFor(at), from: undefined };
};


/* WHY A JOB ENDED ON SIGKILL (2026-11-05). A command killed for memory ends its job with 137, the same code `kill -9`
   leaves, and the job's runner publishes it the moment the command is gone: the kill's own record (memory-kills.jsonl,
   written by netd's guard or the daemon's OOM detector) can land a moment after. A report of a 137 that has no kill on
   its job yet reads the kills file once more and gives the mark a short while to land, once per job, so a `wait` parked
   on the job says what killed it rather than a bare code; a 137 nothing killed for memory costs that wait only once. */
const KILL_WAIT_MS = 2_000;
const KILL_POLL_MS = 100;
const SIGKILLED = 137;
const waitedForKill = new WeakSet<BackgroundJob>();

const killedForMemory = async (job: BackgroundJob, code: number): Promise<string | undefined> => {
    const said = async (): Promise<string | undefined> => (await tailOf(job, MEMORY_KILL_FILE, 4_000)).trim() || undefined;
    const now = await said();
    if (now !== undefined || code !== SIGKILLED || waitedForKill.has(job)) {
        return now;
    }
    waitedForKill.add(job);
    for (let waited = 0; waited < KILL_WAIT_MS; waited += KILL_POLL_MS) {
        await settleMemoryKills();
        const marked = await said();
        if (marked !== undefined) {
            return marked;
        }
        await sleep(KILL_POLL_MS);
    }
    return undefined;
};

/* AN END HANDED OVER IS AN END TOLD (2026-11-17, the shinobi-society audit). Every reader of a finished job's report is
   the agent's own call (`wait`, `stop`), so the end it carries has reached the model: the turn's ending then owes it no
   wake. Until now only Claude Code's completion notice said so, and a job no CLI ever knew as a task (one the daemon runs
   itself, daemon-jobs.ts, or any job under a runtime without those notices) woke its conversation a second time with an
   end the agent had already read. */
const told = (actors: Holders, job: BackgroundJob): void => {
    const record = actors.holdings(JOBS).get(job.id);
    if (record !== undefined) {
        record.notice = "read";
    }
};

export const jobReport = async (actors: Holders, job: BackgroundJob, now: number = Date.now(), procRoot = "/proc"): Promise<JobReport> => {
    const finished = jobFinished(job);
    if (finished) {
        told(actors, job);
    }
    const status = finished ? (await tailOf(job, STATUS_FILE, 64)).trim() : "";
    const code = status === "" ? Number.NaN : Number(status);
    const killed = finished ? await killedForMemory(job, code) : undefined;
    const stopped = finished ? (await tailOf(job, STOP_REASON_FILE, 4_000)).trim() || undefined : undefined;
    const output = finished ? { tail: await tailOf(job, OUTPUT_FILE, OUTPUT_TAIL_BYTES), quiet: undefined, from: undefined } : await runningOutput(job, now, procRoot);
    const waiting = finished ? undefined : inputWaitAt(job.dir);
    return {
        id: jobHandle(actors, job),
        command: jobCommandLine(job.command),
        exitCode: Number.isInteger(code) ? code : undefined,
        running: !finished,
        outputTail: output.tail,
        outputFile: jobOutputPath(job),
        ...opt("outputTailFrom", output.from),
        ...opt("killedForMemory", killed),
        ...opt("stoppedBecause", stopped),
        ...opt("quietForSeconds", output.quiet),
        ...opt(
            "waitingForInput",
            waiting === undefined ? undefined : { program: waiting.program, pid: waiting.pid, forSeconds: Math.max(0, Math.round((now - waiting.since) / 1000)) },
        ),
    };
};

import { statSync } from "node:fs";
import { opt } from "../../../opt.js";
import { type BackgroundJob, type Holders, jobCommandLine, jobFinished, jobHandle, jobOutputPath, OUTPUT_TAIL_BYTES } from "./background-jobs.js";
import { inputWaitAt } from "./input-wait-follow.js";
import { OUTPUT_FILE, STATUS_FILE } from "./job-files.js";
import { readRunFile } from "./run-files.js";

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
    // While it sits at a prompt nobody will answer (input-wait.ts): the process waiting, and for how long.
    readonly waitingForInput?: { readonly program: string; readonly pid: number; readonly forSeconds: number };
}

// Whole seconds since the output last grew, from the capture's own mtime; the start when it never printed.
const quietSince = (job: BackgroundJob, now: number): number | undefined => {
    try {
        return Math.max(0, Math.round((now - Math.max(job.startedAt, statSync(jobOutputPath(job)).mtimeMs)) / 1000));
    } catch {
        // allow(silent-catch): a capture the tmp sweep already took has no silence to measure.
        return undefined;
    }
};


export const jobReport = async (actors: Holders, job: BackgroundJob, now: number = Date.now()): Promise<JobReport> => {
    const finished = jobFinished(job);
    const status = finished ? (await tailOf(job, STATUS_FILE, 64)).trim() : "";
    const code = status === "" ? Number.NaN : Number(status);
    const quiet = finished ? undefined : quietSince(job, now);
    const waiting = finished ? undefined : inputWaitAt(job.dir);
    return {
        id: jobHandle(actors, job),
        command: jobCommandLine(job.command),
        exitCode: Number.isInteger(code) ? code : undefined,
        running: !finished,
        outputTail: await tailOf(job, OUTPUT_FILE, OUTPUT_TAIL_BYTES),
        outputFile: jobOutputPath(job),
        ...opt("quietForSeconds", quiet),
        ...opt(
            "waitingForInput",
            waiting === undefined ? undefined : { program: waiting.program, pid: waiting.pid, forSeconds: Math.max(0, Math.round((now - waiting.since) / 1000)) },
        ),
    };
};

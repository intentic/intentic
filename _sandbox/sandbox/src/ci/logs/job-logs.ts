import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";

// WHERE A FAILED JOB'S WHOLE LOG IS KEPT FOR ITS FIX AGENT. The digest (failure-digest.ts) is what an agent reads first,
// but a cause it cut off used to cost the agent a log download through the forge's API (21 MB for one verify group,
// fetched again by every attempt, with a token that only works through the credential gateway). The daemon already
// holds each failed job's log whole when it reads it for the digest, so it writes it here once and the prompt names the
// file. In the container's temporary directory, which every unfenced turn shares: not the logs tree, whose pruner cuts a
// file to its last megabyte when a log's cause sits anywhere in it, and not the history volume, where nothing need
// outlive the streak (a restart re-reads the runs it replays, and writes their logs again).

// The directory every repository's kept logs go under.
export const ciLogsRoot = (env: NodeJS.ProcessEnv = process.env): string => join(env["TMPDIR"] ?? tmpdir(), "intentic-ci-logs");
// Runs kept per repository, newest first: a streak's fix agent reads its own run's logs and a few later ones.
const RUNS_KEPT = 12;

// A name the filesystem takes as one path segment, and a person still reads.
const segment = (text: string): string =>
    text
        .replace(/[^\w.-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "job";

export const jobLogPath = (root: string, repo: string, runId: number, jobId: number, jobName: string): string =>
    join(root, segment(repo), String(runId), `${jobId}-${segment(jobName)}.log`);

// The runs past the newest RUNS_KEPT of a repository's directory, removed. A run directory that vanishes meanwhile (a
// second prune) is simply gone.
const pruneRuns = async (repoDir: string): Promise<void> => {
    const names = (await readdir(repoDir).catch(undefinedIfMissing)) ?? [];
    const runs = await Promise.all(
        names.map(async (name) => ({ name, modified: (await stat(join(repoDir, name)).catch(undefinedIfMissing))?.mtimeMs ?? 0 })),
    );
    const stale = runs.toSorted((a, b) => b.modified - a.modified).slice(RUNS_KEPT);
    await Promise.all(stale.map((run) => rm(join(repoDir, run.name), { recursive: true, force: true })));
};

/** Writes a failed job's whole log where its fix agent can read it, prunes the repository's older runs, and answers with
 *  the file's path. An empty log is not kept. */
export const keepJobLog = async (
    root: string,
    job: { readonly repo: string; readonly runId: number; readonly jobId: number; readonly name: string },
    log: string,
): Promise<string | undefined> => {
    if (log === "") {
        return undefined;
    }
    const path = jobLogPath(root, job.repo, job.runId, job.jobId, job.name);
    await mkdir(join(root, segment(job.repo), String(job.runId)), { recursive: true });
    await writeFile(path, log);
    await pruneRuns(join(root, segment(job.repo)));
    return path;
};

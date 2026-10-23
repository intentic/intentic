import { isInfraStep } from "@intentic/constants/ci-infra-steps";
import { fnvDigest } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { CiMainFailure } from "@intentic/sandbox-contract/schemas/ci";
import type { CiFailure, CiFinding } from "./ci-store.js";
import { infraLog } from "./ci-fix.js";
import { opt } from "../opt.js";

/* MAIN'S STREAK, AS A RECORD. What main-fixer.ts keeps in the CI store about one failing main line, built up one failed
   job at a time and told apart by workflow: the pure half of the fixer, which reads no forge and starts no agent. */

// Failed jobs one streak remembers having heard of.
const HEARD_KEPT = 200;
// The workflow of a run whose forge runs one pipeline per commit (GitLab), or that named none.
const ONE_PIPELINE = "ci";

// Why GitLab says a job failed, where the runner or the scheduler failed and not the code.
const GITLAB_FLEET_REASONS: ReadonlySet<string> = new Set([
    "runner_system_failure",
    "scheduler_failure",
    "runner_unsupported",
    "api_failure",
    "data_integrity_failure",
]);

// One job that failed, as the fixer hears of it: from the job's own webhook, from its run's, or from a runs list.
export interface FailedJob {
    readonly runId: number;
    readonly jobId: number;
    readonly name: string;
    readonly branch: string;
    // The workflow it is a job of, where a push starts several (GitHub).
    readonly workflow?: string | undefined;
    readonly sha?: string | undefined;
    // The job's page, else its run's.
    readonly url?: string | undefined;
    // The first step it failed in, where the forge names steps (GitHub).
    readonly step?: string | undefined;
    // Every step it failed in, in order, where the forge names steps.
    readonly steps?: readonly string[] | undefined;
    // Why it failed, in the forge's own word, where it says (GitLab's `failure_reason`).
    readonly reason?: string | undefined;
}

export const heardOf = (job: Pick<FailedJob, "runId" | "jobId">): string => `${job.runId}/${job.jobId}`;
export const workflowOf = (workflow: string | undefined): string => (workflow === undefined || workflow === "" ? ONE_PIPELINE : workflow);
// The one conversation on a streak: the newest a fix-up decision named.
export const fixerOf = (streak: CiFailure): string | undefined => streak.decisions.findLast((decision) => decision.kind === "fix-up")?.conversationId;

// The branch's current failure as the Pipelines board reads it, with each workflow's newest failed run.
export const mainFailureOf = ([key, streak]: readonly [string, CiFailure]): CiMainFailure => {
    const [repo = "", branch = ""] = key.split("\n");
    return {
        repo,
        branch,
        since: streak.since,
        runId: streak.runId,
        jobs: streak.findings.map(({ text }) => text),
        workflows: Object.entries(streak.workflows).map(([name, runId]) => ({
            name,
            runId,
            jobs: streak.findings.filter((finding) => finding.source === name).map(({ text }) => text),
        })),
        ...opt("fixer", fixerOf(streak)),
        ...opt("decision", streak.decisions.at(-1)),
    };
};
export const findingOf = (workflow: string, job: string): CiFinding => ({
    id: fnvDigest(`${workflow}\n${job}`),
    source: workflow,
    text: job,
});

// Whether the fleet failed the job rather than the code: a runner-owned step, the forge's own reason, or a log naming
// the fleet. Missing evidence never reads as the fleet's.
export const fleetFailed = (job: FailedJob, log: string): boolean =>
    (job.step !== undefined && isInfraStep(job.step)) || (job.reason !== undefined && GITLAB_FLEET_REASONS.has(job.reason)) || infraLog(log);

// The streak once a run's jobs are handed over: heard, so no later news of them is handed over again.
export const withHeard = (current: CiFailure, jobs: readonly Pick<FailedJob, "runId" | "jobId">[]): CiFailure => ({
    ...current,
    heard: [...new Set([...current.heard, ...jobs.map(heardOf)])].slice(-HEARD_KEPT),
});

// A successful manual start gives the streak its turns back and acknowledges only the evidence its prompt received.
export const withFixPressed = (
    current: CiFailure,
    press: { readonly runId: number; readonly failedJobIds: readonly number[]; readonly conversationId: string; readonly at: number },
): CiFailure => ({
    ...withHeard(current, press.failedJobIds.map((jobId) => ({ runId: press.runId, jobId }))),
    turns: 0,
    decisions: [
        ...current.decisions,
        { kind: "fix-up", conversationId: press.conversationId, at: press.at, detail: "A person pressed Fix: the fix agent has its turns back." },
    ],
});

// The streak after one more failed job: begun at it when there was none. What the banner shows moves now; the job is
// heard only once it is handed over (withHeard).
export const withJob = (current: CiFailure | undefined, job: FailedJob, now: number): CiFailure => {
    const workflow = workflowOf(job.workflow);
    const streak: CiFailure = current ?? {
        since: now,
        findings: [],
        decisions: [],
        firstRunId: job.runId,
        runId: job.runId,
        count: 0,
        workflows: {},
        heard: [],
        turns: 0,
        changed: false,
    };
    const newest = streak.workflows[workflow];
    const finding = findingOf(workflow, job.name);
    return {
        ...streak,
        runId: Math.max(streak.runId, job.runId),
        count: streak.count + (newest === undefined || job.runId > newest ? 1 : 0),
        workflows: { ...streak.workflows, [workflow]: Math.max(newest ?? 0, job.runId) },
        findings: streak.findings.some((owed) => owed.id === finding.id) ? streak.findings : [...streak.findings, finding],
    };
};

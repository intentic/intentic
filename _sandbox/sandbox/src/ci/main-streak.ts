import { isInfraStep } from "@intentic/constants/ci-infra-steps";
import { fnvDigest } from "@intentic/sandbox-contract/ids/conversation-ids";
import { type CiMainFailure, MAIN_FAILURE_STALE_MS } from "@intentic/sandbox-contract/schemas/ci";
import type { CiFailure, CiFinding } from "./ci-store.js";
import { infraLog } from "./ci-fix.js";
import { opt } from "../opt.js";

/* MAIN'S STREAK, AS A RECORD. What main-fixer.ts keeps in the CI store about one failing main line, built up one failed
   job at a time and told apart by workflow: the pure half of the fixer, which reads no forge and starts no agent. */

// Failed jobs one streak remembers having heard of.
const HEARD_KEPT = 200;
// The workflow of a run whose forge runs one pipeline per commit (GitLab), or that named none.
const ONE_PIPELINE = "ci";

// Why a job failed, where the runner or the scheduler failed and not the code: GitLab's own `failure_reason`, and a
// GitHub job no runner took (forge/github-cancels.ts).
const FLEET_REASONS: ReadonlySet<string> = new Set([
    "runner_system_failure",
    "scheduler_failure",
    "runner_unsupported",
    "api_failure",
    "data_integrity_failure",
    "runner_unavailable",
]);
// Why a job failed, where it ran out of time: a GitHub job past its `timeout-minutes`, a GitLab job past its timeout.
const TIMEOUT_REASONS: ReadonlySet<string> = new Set(["timed_out", "job_execution_timeout"]);
// What sets off a GitHub run that is none of main's CI: `dynamic` is GitHub's own workflows run on the repository's
// default branch (Dependabot's updates, CodeQL's default setup, Copilot's sessions). Each Dependabot update is a
// workflow of its own name, so one that failed never ran again to pass, and held main's failure open for weeks.
const NOT_MAINS: ReadonlySet<string> = new Set(["dynamic"]);

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
    // Why it failed, in the forge's own word, where it says (GitLab's `failure_reason`), or why GitHub's cancel of it is a
    // failure (forge/github-cancels.ts).
    readonly reason?: string | undefined;
    // What set its run off, in the forge's word, where it is known.
    readonly trigger?: string | undefined;
}

// Whether a run set off this way is main's CI at all (NOT_MAINS).
export const isMainsOwn = (trigger: string | undefined): boolean => trigger === undefined || !NOT_MAINS.has(trigger);

export const heardOf = (job: Pick<FailedJob, "runId" | "jobId">): string => `${job.runId}/${job.jobId}`;
export const workflowOf = (workflow: string | undefined): string => (workflow === undefined || workflow === "" ? ONE_PIPELINE : workflow);
// The one conversation on a streak: the newest a fix-up decision named.
export const fixerOf = (streak: CiFailure): string | undefined => streak.decisions.findLast((decision) => decision.kind === "fix-up")?.conversationId;

// The branch's current failure as the Pipelines board reads it, with each workflow's newest failed run.
export const mainFailureOf = ([key, streak]: readonly [string, CiFailure]): CiMainFailure => {
    const [repo = "", branch = ""] = key.split("\n");
    const attempts = new Set(streak.decisions.flatMap((decision) => (decision.kind === "fix-up" ? [decision.conversationId] : []))).size;
    return {
        repo,
        branch,
        since: streak.since,
        runId: streak.runId,
        jobs: streak.findings.map(({ text }) => text),
        workflows: Object.entries(streak.workflows).map(([name, runId]) => {
            const findings = streak.findings.filter((finding) => finding.source === name);
            const timedOut = findings.filter((finding) => finding.timedOut === true).map(({ text }) => text);
            const span = streak.spans[name];
            return {
                name,
                runId,
                jobs: findings.map(({ text }) => text),
                ...opt("since", span?.since),
                ...opt("failedAt", span?.failedAt),
                ...opt("trigger", span?.trigger),
                ...opt("timedOut", timedOut.length > 0 ? timedOut : undefined),
            };
        }),
        ...opt("fixer", fixerOf(streak)),
        ...opt("decision", streak.decisions.at(-1)),
        ...opt("attempts", attempts > 0 ? attempts : undefined),
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
    (job.step !== undefined && isInfraStep(job.step)) || (job.reason !== undefined && FLEET_REASONS.has(job.reason)) || infraLog(log);

// The streak once a run's jobs are handed over: heard, so no later news of them is handed over again.
export const withHeard = (current: CiFailure, jobs: readonly Pick<FailedJob, "runId" | "jobId">[]): CiFailure => ({
    ...current,
    heard: [...new Set([...current.heard, ...jobs.map(heardOf)])].slice(-HEARD_KEPT),
});

// A successful manual start gives the streak its turns back and acknowledges only the evidence its prompt received.
export const withFixPressed = (
    current: CiFailure,
    press: { readonly jobs: readonly Pick<FailedJob, "runId" | "jobId">[]; readonly conversationId: string; readonly at: number },
): CiFailure => ({
    ...withHeard(current, press.jobs),
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
        spans: {},
        heard: [],
        turns: 0,
        changed: false,
    };
    const newest = streak.workflows[workflow];
    const timedOut = job.reason !== undefined && TIMEOUT_REASONS.has(job.reason);
    const finding = { ...findingOf(workflow, job.name), ...opt("timedOut", timedOut ? true : undefined) };
    const span = streak.spans[workflow];
    // A workflow kept before workflows were timed apart was failing already, at most since the streak began.
    const since = span?.since ?? (newest === undefined ? now : streak.since);
    const trigger = job.trigger ?? span?.trigger;
    return {
        ...streak,
        runId: Math.max(streak.runId, job.runId),
        count: streak.count + (newest === undefined || job.runId > newest ? 1 : 0),
        workflows: { ...streak.workflows, [workflow]: Math.max(newest ?? 0, job.runId) },
        spans: { ...streak.spans, [workflow]: { since, failedAt: now, ...opt("trigger", trigger) } },
        // In place, so the jobs keep the order they began failing in; only whether it timed out moves.
        findings: streak.findings.some((owed) => owed.id === finding.id)
            ? streak.findings.map((owed) => (owed.id === finding.id ? finding : owed))
            : [...streak.findings, finding],
    };
};

// One workflow's times on a streak (ci-store.ts `spans`).
export type WorkflowSpan = CiFailure["spans"][string];

// The streak once the boot learned what the forge says of the workflows it kept with no times (main-ends.ts timedApart):
// each gets its times, one whose run is not main's CI comes off, and so does one stale by them. Undefined when nothing is
// left.
export const withLearnedSpans = (
    streak: CiFailure,
    learned: Readonly<Record<string, WorkflowSpan | "not-mains">>,
    now: number,
): CiFailure | undefined => {
    let next: CiFailure | undefined = streak;
    for (const [workflow, span] of Object.entries(learned)) {
        if (next === undefined || next.workflows[workflow] === undefined || next.spans[workflow] !== undefined) {
            continue;
        }
        next = span === "not-mains" ? withoutWorkflow(next, workflow) : { ...next, spans: { ...next.spans, [workflow]: span } };
    }
    return next === undefined ? undefined : withoutStale(next, now);
};

// The streak without every workflow that has neither failed nor passed for MAIN_FAILURE_STALE_MS: nothing measures it
// (a one-off run, a workflow renamed or no longer scheduled). The same streak when none is, undefined when none is left.
export const withoutStale = (streak: CiFailure, now: number): CiFailure | undefined => {
    let next: CiFailure | undefined = streak;
    for (const [workflow, span] of Object.entries(streak.spans)) {
        if (next !== undefined && now - span.failedAt > MAIN_FAILURE_STALE_MS) {
            next = withoutWorkflow(next, workflow);
        }
    }
    return next;
};

// The streak without a workflow: its newest failed run, its jobs failing and its times. Undefined when it was the last.
export const withoutWorkflow = (streak: CiFailure, workflow: string): CiFailure | undefined => {
    const { [workflow]: _run, ...workflows } = streak.workflows;
    const { [workflow]: _span, ...spans } = streak.spans;
    return Object.keys(workflows).length === 0
        ? undefined
        : { ...streak, workflows, spans, findings: streak.findings.filter((owed) => owed.source !== workflow) };
};

// What a finished run of a workflow says that did not pass as a whole (cancelled, or failed elsewhere): each of the
// workflow's jobs failing on main that passed in it is fixed, and a workflow with no job left failing comes off, since
// every job that failed on it has passed since. A run older than the workflow's newest failure says nothing. Then the
// stale come off (withoutStale). The same streak when nothing changed, undefined when nothing is left.
export const withRecovered = (
    streak: CiFailure,
    run: { readonly workflow: string; readonly runId: number; readonly passed: readonly string[] },
    now: number,
): CiFailure | undefined => {
    let next: CiFailure | undefined = streak;
    const newest = streak.workflows[run.workflow];
    if (newest !== undefined && run.runId >= newest) {
        const passed = new Set(run.passed);
        const findings = streak.findings.filter((owed) => owed.source !== run.workflow || !passed.has(owed.text));
        next = findings.length === streak.findings.length ? streak : { ...streak, findings };
        if (!next.findings.some((owed) => owed.source === run.workflow)) {
            next = withoutWorkflow(next, run.workflow);
        }
    }
    return next === undefined ? undefined : withoutStale(next, now);
};

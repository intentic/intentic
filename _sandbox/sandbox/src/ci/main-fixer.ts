import { serialLock } from "@intentic/base/async";
import { isInfraStep } from "@intentic/constants/ci-infra-steps";
import {
    type AgentSummary,
    CI_FIX_PREFIX,
    ciFixConversationId,
    type CiMainFailure,
    fixStance,
    fnvDigest,
    isPipelineInFlight,
    type MainFailureDecision,
    type MainFailureHandBack,
    type PipelineRun,
} from "@intentic/sandbox-contract";
import { deliverWake } from "../agent/run/turn/wake-delivery.js";
import type { Services } from "../composition.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import { opt } from "../opt.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import type { CiFailure, CiFinding } from "./ci-store.js";
import { FIX_LOG_BYTES, infraLog, startCiFix, WHOLE_LOG } from "./ci-fix.js";
import { digestOf, excerptOf, type JobExcerpt } from "./failure-digest.js";
import { isMainLine } from "./main-line.js";
import { ciProjects, type CiProject } from "./projects.js";
import { ciClientFor, type FailedStep, type FetchFn } from "./providers.js";

/* MAIN'S CI HAS ONE FIX AGENT, AND IT HEARS EACH RUN ONCE, WHOLE. A run's failed jobs on a repository's main line (its
   default branch, main-line.ts) are parked as they fail, and handed over together when the run finishes, or when it is
   still going RUN_SETTLE_CAP_MS after its first failure (anything failing after that follows at the run's end). The
   first run to fail starts the agent with every job it failed; each later run's failures are said to the same
   conversation as one message: into its live turn, as a turn of its own when it is idle, queued otherwise. So it never
   watches a run itself, nobody decides who broke what, and one cause failing six jobs costs one turn rather than six.
   The streak ends when a later run of every workflow that failed on it passes.

   (2026-10-02: per run rather than per job. Started at the first failed job, the agent was handed preflight's two
   minutes of checks while the verify groups were still building, ended its turn, and was then woken once per job that
   failed after: since 2026-09-30 it spent its three turns that way five times. Waiting costs ~7 minutes at the median,
   the time between a run's first failed job and its last. This is not the retired 09-23 repair gate's quiet window,
   which waited for pushes to stop and so could hold the agent back for as long as main kept moving: this waits for one
   run, and never past the cap.)

   It gets a few turns, and hands the failure to the owner when they are spent, or when its turn ends without it having
   changed anything (a failure that is not in the code: the runner's environment, a tool's version, a secret) or ends
   failed, stopped or archived. A failed job the CI fleet died in is never its work: a run whose every failure is the
   fleet's is re-run once, which the CI store keeps too. The streak is kept in the CI store (ci-store.ts), so a restart neither forgets it nor starts a
   second agent on it; the Agent tab's Repair switch (`autoRepair`) off, a failing main is only reported. */

// Turns the sandbox starts for the fix agent in one streak; words said into its live turn are none. One run's failures
// are one message, so this is three runs' worth.
export const TURNS_PER_STREAK = 3;
// How long a run still going after its first failure is waited on before what failed so far is handed over: past the
// end of measuring for nearly every run (verification was done by 41 minutes from the start at p90 across September
// 2026), and short of a release that a failed clock or perf job does not stop.
export const RUN_SETTLE_CAP_MS = 45 * 60_000;
// Failed jobs one streak remembers having heard of.
const HEARD_KEPT = 200;
// The workflow of a run whose forge runs one pipeline per commit (GitLab), or that named none.
const ONE_PIPELINE = "ci";
// Runs listed at boot, looking for what main did while the daemon was down.
const RUNS_LISTED = 15;
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

// What became of one failed job: somebody's (sent, recorded, or not main's), or the fleet's.
type Verdict = "code" | "fleet" | "skipped";

// One failed job parked for its run's handover, with what is kept of its log.
interface Parked {
    readonly job: FailedJob;
    readonly excerpt: JobExcerpt;
}

// A run's failed jobs heard and not yet handed over, by job id, and the clock that hands them over if the run goes on.
interface Batch {
    readonly jobs: Map<number, Parked>;
    readonly timer: ReturnType<typeof setTimeout>;
}

// Why a run's failures are handed over now: the run finished, or it was still going when its clock ran out.
type HandOverReason = "finished" | "capped";

// What only this process holds: a lock per branch, so one branch's news is decided in the order it arrived; the fleet
// failures already judged, so a job's log is not read twice for them; and each run's failed jobs not yet handed over.
// Losing them to a restart costs a read: `heard` is written only at a handover, so the boot's replay of the runs since
// the streak began (resumeMainFixer) parks and hands over again whatever this process held.
const locks = new Map<string, ReturnType<typeof serialLock>>();
const fleetJobs = new Set<string>();
const batches = new Map<string, Batch>();
let settleCapMs = RUN_SETTLE_CAP_MS;

const keyOf = (repo: string, branch: string): string => `${repo}\n${branch}`;
const batchKeyOf = (repo: string, runId: number): string => `${repo}\n${runId}`;
const heardOf = (job: Pick<FailedJob, "runId" | "jobId">): string => `${job.runId}/${job.jobId}`;
const workflowOf = (workflow: string | undefined): string => (workflow === undefined || workflow === "" ? ONE_PIPELINE : workflow);
const findingOf = (workflow: string, job: string): CiFinding => ({
    id: fnvDigest(`${workflow}\n${job}`),
    source: workflow,
    text: job,
});

const serially = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const lock = locks.get(key) ?? serialLock();
    locks.set(key, lock);
    return lock(work);
};

// Where a best-effort step failed, for its log line.
interface Where {
    readonly repo?: string;
    readonly runId?: number;
    readonly jobId?: number;
    readonly fixer?: string;
    readonly type?: string;
}

// A best-effort step: what it answers, or, when it throws, the fallback, with the failure logged. Nothing the fixer does
// may fail the delivery or the pass that brought it the news.
const orElse = async <T>(services: Pick<Services, "logger">, work: Promise<T>, fallback: T, message: string, where: Where): Promise<T> => {
    try {
        return await work;
    } catch (error) {
        services.logger.warn({ ...where, err: error }, message);
        return fallback;
    }
};

// The one conversation on a streak: the newest a fix-up decision named.
export const fixerOf = (streak: CiFailure): string | undefined => streak.decisions.findLast((decision) => decision.kind === "fix-up")?.conversationId;
// Whether the failure was handed to the owner since its fix agent was last given it.
const waitsForOwner = (streak: CiFailure): boolean => streak.decisions.at(-1)?.kind === "spent";

const tell = (services: Services, type: string, content: string, outcome: "ok" | "error", conversationId?: string): void => {
    void orElse(
        services,
        services.activity.append({ direction: "system", type, content, outcome, ...opt("conversationId", conversationId) }),
        undefined,
        "ci repair: activity append failed",
        { type },
    );
};

const decided = async (services: Services, repo: string, branch: string, decision: MainFailureDecision): Promise<void> => {
    await services.ciStore.failure(repo, branch, (current) =>
        current === undefined ? current : { ...current, decisions: [...current.decisions, decision] },
    );
    publishRuntimeChange("ci");
};

// Each reason a fix agent hands the failure back for, in the few words the sandbox says it in. The decision carries the
// reason too, for a screen to word in its own language; what the turn or the delivery said goes to the log only.
const HAND_BACK = {
    turns: `its fix agent had its ${TURNS_PER_STREAK} turns and main still fails`,
    "no-change": "its fix agent finished without changing anything",
    stopped: "its fix agent was stopped",
    interrupted: "its fix agent's turn was cut off",
    "turn-failed": "its fix agent's turn failed",
    gone: "its fix agent is gone",
    refused: "its fix agent could not take the newest failure",
} satisfies Readonly<Record<MainFailureHandBack, string>>;

// Why a failure goes back to the owner: the reason, the words for it where they say more than the reason's own, and the
// raw cause for the log.
interface HandBack {
    readonly reason: MainFailureHandBack;
    readonly words?: string;
    readonly cause?: string | undefined;
}

// An archived fix agent is gone like a deleted one, in its own words.
const ARCHIVED: HandBack = { reason: "gone", words: "its fix agent was archived" };

// The failure handed to the owner: nothing more is sent to its fix agent until a person presses Fix.
const handOver = async (services: Services, repo: string, branch: string, fixer: string | undefined, handBack: HandBack): Promise<void> => {
    const words = handBack.words ?? HAND_BACK[handBack.reason];
    await decided(services, repo, branch, {
        kind: "spent",
        reason: handBack.reason,
        ...opt("conversationId", fixer),
        at: Date.now(),
        detail: `${words.charAt(0).toUpperCase()}${words.slice(1)}.`,
    });
    services.logger.info(
        { repo, branch, fixer, reason: handBack.reason, ...opt("cause", handBack.cause) },
        "ci repair: the failure was handed to the owner",
    );
    tell(services, "ci.repair_needs_you", `${branch} of ${repo} still fails and waits for you: ${words}.`, "error", fixer);
};

// Why a fix agent's ended turn hands the failure over, or undefined when it does not: a turn that changed nothing after
// the agent had changed something already found nothing left to do, and its turns are counted anyway.
const endedHandBack = (agent: AgentSummary, streak: CiFailure): HandBack | undefined => {
    if (fixStance(agent).kind !== "ended") {
        return undefined;
    }
    switch (agent.status) {
        case "idle":
            return streak.changed ? undefined : { reason: "no-change" };
        case "stopped":
            return { reason: "stopped" };
        case "interrupted":
            return { reason: "interrupted" };
        default:
            return { reason: "turn-failed", cause: agent.failure };
    }
};

// A run's failed jobs, in the words a turn reads them by.
const jobsFailed = (runId: number, parked: readonly Parked[]): string =>
    `run ${runId} failed ${parked.length === 1 ? "1 job" : `${parked.length} jobs`}: ${parked.map(({ job }) => `"${job.name}"`).join(", ")}`;

// What the list is: the run's whole word, or what had failed by the time its clock ran out.
const completeness = (reason: HandOverReason): string =>
    reason === "finished"
        ? `The run has finished, and every verification job in it ran whatever the others concluded, so this is the whole list of what it found wrong.`
        : `The run was still going ${Math.round(settleCapMs / 60_000)} minutes after its first failure, so these are the jobs that had failed by then; any that fails later in it is sent to you when it finishes.`;

// What the fix agent is told first, ahead of the failure's evidence.
const openingPreface = (project: CiProject, branch: string, runId: number, parked: readonly Parked[], reason: HandOverReason): string =>
    [
        `Main's CI is failing: ${jobsFailed(runId, parked)}, on ${branch} of "${project.repo}".`,
        completeness(reason),
        `One cause often fails several jobs (a type error fails every group that compiles it), so group what is below by cause and fix every cause in this turn, not only the first.`,
        `You are the one fix agent for this failure. Every later failure on ${branch} is sent to this conversation until ${branch} passes again, so do not wait on runs or watch them: fix what failed, then end your turn.`,
        `Your work lands in the main tree like any conversation's; the owner commits and pushes it, and the next run on ${branch} measures it.`,
    ].join(" ");

// What a later run's failures say to the fix agent already on the streak.
const followUp = (project: CiProject, streak: CiFailure, branch: string, runId: number, parked: readonly Parked[], reason: HandOverReason): string => {
    const sha = parked[0]?.job.sha;
    return [
        [
            `More of main's CI failed: ${jobsFailed(runId, parked)}, on ${branch} of "${project.repo}".`,
            runId === streak.firstRunId
                ? `It is the run this failure began in.`
                : `It is a later run${sha === undefined ? "" : `, at commit ${sha.slice(0, 7)}`}.`,
            completeness(reason),
            `If what you already changed covers them (the run's commit predates your change), say so and change nothing; otherwise fix them too, every cause, then end your turn.`,
        ].join(" "),
        `--- what failed ---\n${digestOf(parked.map(({ excerpt }) => excerpt))}`,
    ].join("\n\n");
};

// Whether the fleet failed the job rather than the code: a runner-owned step, the forge's own reason, or a log naming
// the fleet. Missing evidence never reads as the fleet's.
const fleetFailed = (job: FailedJob, log: string): boolean =>
    (job.step !== undefined && isInfraStep(job.step)) || (job.reason !== undefined && GITLAB_FLEET_REASONS.has(job.reason)) || infraLog(log);

// The streak once a run's jobs are handed over: heard, so no later news of them is handed over again.
const withHeard = (current: CiFailure, jobs: readonly FailedJob[]): CiFailure => ({
    ...current,
    heard: [...current.heard, ...jobs.map(heardOf)].slice(-HEARD_KEPT),
});

// The streak after one more failed job: begun at it when there was none. What the banner shows moves now; the job is
// heard only once it is handed over (withHeard).
const withJob = (current: CiFailure | undefined, job: FailedJob, now: number): CiFailure => {
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

// Puts the streak's fix agent on it, with every job its first failed run failed: a fresh conversation named for the run
// the streak began in. Whether the run's jobs reached it, so they are heard.
const startFixer = async (
    services: Services,
    project: CiProject,
    streak: CiFailure,
    branch: string,
    runId: number,
    parked: readonly Parked[],
    reason: HandOverReason,
    fetchFn: FetchFn,
): Promise<boolean> => {
    const names = parked.map(({ job }) => job.name);
    const outcome = await orElse(
        services,
        startCiFix(
            services,
            {
                project,
                runId,
                base: ciFixConversationId(project.repo, streak.firstRunId),
                evidence: { failedJobs: names, logs: digestOf(parked.map(({ excerpt }) => excerpt)), infra: false, infraSteps: [] },
                preface: openingPreface(project, branch, runId, parked, reason),
            },
            fetchFn,
        ),
        undefined,
        "ci repair: the fix agent did not start",
        { repo: project.repo, runId },
    );
    if (outcome === undefined) {
        return false;
    }
    await services.ciStore.failure(project.repo, branch, (current) =>
        current === undefined
            ? current
            : {
                  ...current,
                  turns: current.turns + (outcome.kind === "started" ? 1 : 0),
                  decisions: [
                      ...current.decisions,
                      {
                          kind: "fix-up",
                          conversationId: outcome.conversationId,
                          at: Date.now(),
                          detail: `Run ${runId} failed ${names.join(", ")}, and put a fix agent on it with all of them; every later run's failures go to the same one.`,
                      },
                  ],
              },
    );
    publishRuntimeChange("ci");
    if (outcome.kind === "started") {
        tell(
            services,
            "ci.repair_started",
            `${branch} of ${project.repo} started failing in run ${runId}, at ${names.join(", ")}: a fix agent is on it with all of them, and every later failure goes to it.`,
            "ok",
            outcome.conversationId,
        );
        return true;
    }
    // An attempt at this streak's id was already in play (a person's press got there first): it is the fix agent, and
    // hears this run like any later one.
    const current = (await services.ciStore.failures())[keyOf(project.repo, branch)];
    return current === undefined ? false : sendOn(services, project, current, branch, runId, parked, reason);
};

// Says a run's failures to the streak's fix agent as one message, or hands the failure over when it can take no more.
// Whether they reached it, so they are heard.
const sendOn = async (
    services: Services,
    project: CiProject,
    streak: CiFailure,
    branch: string,
    runId: number,
    parked: readonly Parked[],
    reason: HandOverReason,
): Promise<boolean> => {
    const fixer = fixerOf(streak);
    const agent = fixer === undefined ? undefined : services.agents.get(fixer);
    const entry = fixer === undefined ? undefined : services.agents.entry(fixer);
    if (fixer === undefined || agent === undefined || entry === undefined || agent.archivedAt !== undefined) {
        await handOver(services, project.repo, branch, fixer, agent?.archivedAt === undefined ? { reason: "gone" } : ARCHIVED);
        return false;
    }
    const ended = endedHandBack(agent, streak);
    if (ended !== undefined) {
        await handOver(services, project.repo, branch, fixer, ended);
        return false;
    }
    // Only a turn the sandbox starts is counted: words said into the live one cost it none.
    if (!services.conversations.running(fixer) && streak.turns >= TURNS_PER_STREAK) {
        await handOver(services, project.repo, branch, fixer, { reason: "turns" });
        return false;
    }
    const receipt = await orElse(
        services,
        deliverWake(
            { turns: services.turns, sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId) },
            {
                conversationId: fixer,
                prompt: followUp(project, streak, branch, runId, parked, reason),
                voice: "sandbox",
                errand: "ci-fix-nudge",
                source: "ci",
                profile: conversationProfile(entry),
            },
        ),
        undefined,
        "ci repair: the failure could not be said to the fix agent",
        { fixer },
    );
    if (receipt === undefined) {
        return false;
    }
    if ("why" in receipt || "invalid" in receipt) {
        await handOver(services, project.repo, branch, fixer, { reason: "refused", cause: "why" in receipt ? receipt.why : receipt.invalid });
        return false;
    }
    if (receipt.delivered !== "steered") {
        await services.ciStore.failure(project.repo, branch, (current) => (current === undefined ? current : { ...current, turns: current.turns + 1 }));
    }
    return true;
};

// Hands a run's parked jobs over as one: to a fix agent started for them, or to the one already on the streak. Nobody is
// told when a later pass ended the failure, it waits for the owner, or repairs were switched off meanwhile.
const handOverRun = (services: Services, project: CiProject, branch: string, runId: number, reason: HandOverReason, fetchFn: FetchFn): Promise<void> =>
    serially(keyOf(project.repo, branch), async () => {
        const key = batchKeyOf(project.repo, runId);
        const batch = batches.get(key);
        if (batch === undefined) {
            return;
        }
        batches.delete(key);
        clearTimeout(batch.timer);
        const parked = [...batch.jobs.values()];
        const streak = (await services.ciStore.failures())[keyOf(project.repo, branch)];
        if (parked.length === 0 || streak === undefined || waitsForOwner(streak) || !(await services.sandboxSettings.get()).autoRepair) {
            return;
        }
        const reached =
            fixerOf(streak) === undefined
                ? await startFixer(services, project, streak, branch, runId, parked, reason, fetchFn)
                : await sendOn(services, project, streak, branch, runId, parked, reason);
        if (reached) {
            await services.ciStore.failure(project.repo, branch, (current) =>
                current === undefined ? current : withHeard(current, parked.map(({ job }) => job)),
            );
        }
    });

// Parks a failed job for its run's handover, and starts the run's clock when it is the run's first.
const park = (services: Services, project: CiProject, job: FailedJob, log: string, fetchFn: FetchFn): void => {
    const key = batchKeyOf(project.repo, job.runId);
    const batch: Batch = batches.get(key) ?? {
        jobs: new Map(),
        timer: setTimeout(() => {
            void orElse(
                services,
                handOverRun(services, project, job.branch, job.runId, "capped", fetchFn),
                undefined,
                "ci repair: a run's failures could not be handed over",
                { repo: project.repo, runId: job.runId },
            );
        }, settleCapMs),
    };
    // The clock must not keep a stopping daemon alive; a restart hands the run over from the forge's own word instead.
    batch.timer.unref?.();
    const steps = job.steps ?? (job.step === undefined ? [] : [job.step]);
    batch.jobs.set(job.jobId, { job, excerpt: excerptOf({ name: job.name, url: job.url, steps, log }) });
    batches.set(key, batch);
};

/** One failed job of a main-line branch: begins the branch's streak, and is parked until its run is handed over to the
 *  fix agent (handOverRun). Each job is handled once however many ways it arrives; a fleet failure, and a failure older
 *  than main's newest pass, are not the agent's. */
export const jobFailed = async (services: Services, project: CiProject, job: FailedJob, fetchFn: FetchFn = fetch): Promise<Verdict> => {
    if (!(await isMainLine(services, project, job.branch))) {
        return "skipped";
    }
    const key = keyOf(project.repo, job.branch);
    return serially(key, async (): Promise<Verdict> => {
        const heard = heardOf(job);
        if (fleetJobs.has(`${project.repo}/${heard}`)) {
            return "fleet";
        }
        const current = (await services.ciStore.failures())[key];
        if (current?.heard.includes(heard) === true || batches.get(batchKeyOf(project.repo, job.runId))?.jobs.has(job.jobId) === true) {
            return "code";
        }
        // A later run of its workflow already passed: older news than main's own.
        if (((await services.ciStore.passes(project.repo, job.branch))[workflowOf(job.workflow)] ?? 0) > job.runId) {
            return "skipped";
        }
        // Whole, for the digest; only its end is asked whether the fleet died, as the runner says that last.
        const log = await orElse(
            services,
            ciClientFor(project.account.provider, fetchFn).jobLog(project, job.jobId, WHOLE_LOG),
            "",
            "ci repair: the failed job's log could not be read",
            { repo: project.repo, jobId: job.jobId },
        );
        if (fleetFailed(job, log.slice(-FIX_LOG_BYTES))) {
            fleetJobs.add(`${project.repo}/${heard}`);
            return "fleet";
        }
        const streak = await services.ciStore.failure(project.repo, job.branch, (previous) => withJob(previous, job, Date.now()));
        publishRuntimeChange("ci");
        if (streak === undefined || waitsForOwner(streak)) {
            return "code";
        }
        if (!(await services.sandboxSettings.get()).autoRepair) {
            if (streak.decisions.at(-1)?.kind !== "reported") {
                await decided(services, project.repo, job.branch, {
                    kind: "reported",
                    at: Date.now(),
                    detail: "Repairs are off, so nobody was sent.",
                });
            }
            return "code";
        }
        park(services, project, job, log, fetchFn);
        return "code";
    });
};

const jobOf = (run: PipelineRun, step: FailedStep): FailedJob => ({
    runId: run.runId,
    jobId: step.id,
    name: step.job,
    branch: run.branch,
    workflow: run.workflow,
    sha: run.sha,
    url: run.url,
    step: step.step,
    steps: step.steps,
    reason: step.reason,
});

// The failed jobs of a run, in or out of flight; a forge that will not say leaves nothing to act on.
const failedStepsOf = async (services: Services, project: CiProject, run: PipelineRun, fetchFn: FetchFn): Promise<readonly FailedStep[]> =>
    orElse(
        services,
        ciClientFor(project.account.provider, fetchFn).failedSteps(project, run.runId),
        [],
        "ci repair: the run's failed jobs could not be read",
        {
            repo: project.repo,
            runId: run.runId,
        },
    );

// A run the fleet failed is re-run once, kept on file so a restart that hears of it again does not re-run it twice; the
// fleet failing it again is said and left to the owner.
const rerunFleet = async (services: Services, project: CiProject, run: PipelineRun, fetchFn: FetchFn): Promise<void> => {
    if (!(await services.ciStore.fleetRerun(run.repo, run.runId))) {
        tell(
            services,
            "ci.fleet_failed",
            `Run ${run.runId} of ${run.repo} failed on the CI fleet again after a re-run: the runners need a look, not the code.`,
            "error",
        );
        return;
    }
    const rerun = await orElse(
        services,
        ciClientFor(project.account.provider, fetchFn)
            .rerun(project, run.runId)
            .then(() => true),
        false,
        "ci repair: the fleet re-run was refused",
        { repo: run.repo, runId: run.runId },
    );
    if (rerun) {
        tell(services, "ci.fleet_rerun", `Run ${run.runId} of ${run.repo} failed on the CI fleet, not in the code: re-run once.`, "ok");
    }
};

// The streak is over: said, logged with what it cost, and a fix agent still working told it may stop.
const ended = async (services: Services, repo: string, run: PipelineRun, streak: CiFailure): Promise<void> => {
    await services.ciStore.failure(repo, run.branch, () => undefined);
    publishRuntimeChange("ci");
    const fixer = fixerOf(streak);
    const agent = fixer === undefined ? undefined : services.agents.get(fixer);
    const lastedMs = Date.now() - streak.since;
    services.logger.info(
        {
            repo,
            branch: run.branch,
            lastedMs,
            runs: streak.count,
            turns: streak.turns,
            handedOver: streak.decisions.some((decision) => decision.kind === "spent"),
            fixer,
            costUsd: agent?.costUsd,
            inputTokens: agent?.inputTokens,
            outputTokens: agent?.outputTokens,
        },
        "ci repair: streak ended",
    );
    const minutes = Math.max(1, Math.round(lastedMs / 60_000));
    const cost = agent?.costUsd === undefined ? "" : `, for $${agent.costUsd.toFixed(2)}`;
    tell(
        services,
        "ci.repair_retired",
        `${run.branch} of ${repo} passed again at ${run.sha.slice(0, 7)}, ${minutes} min and ${streak.count} failed run(s) after it began failing${fixer === undefined ? "" : `; its fix agent took ${streak.turns} turn(s)${cost}`}.`,
        "ok",
        fixer,
    );
    if (fixer !== undefined && services.conversations.running(fixer)) {
        await orElse(
            services,
            services.turns.steer(fixer, {
                text: `${run.branch} of "${repo}" passed in run ${run.runId}: main no longer fails. Finish what you are doing without starting anything new.`,
                voice: "sandbox",
            }),
            false,
            "ci repair: the fix agent could not be told main passes again",
            { fixer },
        );
    }
};

// A passing run takes its workflow off the streak; the last one off ends it. A failure kept before workflows were told
// apart ends at any pass.
const passed = async (services: Services, project: CiProject, run: PipelineRun): Promise<void> => {
    const workflow = workflowOf(run.workflow);
    await services.ciStore.recordPass(project.repo, run.branch, workflow, run.runId);
    await serially(keyOf(project.repo, run.branch), async () => {
        const streak = (await services.ciStore.failures())[keyOf(project.repo, run.branch)];
        if (streak === undefined) {
            return;
        }
        const failing = Object.keys(streak.workflows);
        const newest = streak.workflows[workflow];
        if (failing.length > 0 && (newest === undefined || run.runId < newest)) {
            return;
        }
        if (failing.length > 1) {
            const { [workflow]: _passed, ...others } = streak.workflows;
            await services.ciStore.failure(project.repo, run.branch, (current) =>
                current === undefined
                    ? current
                    : { ...current, workflows: others, findings: current.findings.filter((owed) => owed.source !== workflow) },
            );
            publishRuntimeChange("ci");
            return;
        }
        await ended(services, project.repo, run, streak);
    });
};

// A failed run's own word on its workflow: the jobs failing there now are exactly the ones it failed, when no newer run
// of the workflow has failed since.
const failedRun = async (services: Services, project: CiProject, run: PipelineRun, failing: readonly string[]): Promise<void> => {
    const workflow = workflowOf(run.workflow);
    const kept = new Set(failing.map((job) => findingOf(workflow, job).id));
    await serially(keyOf(project.repo, run.branch), async () => {
        await services.ciStore.failure(project.repo, run.branch, (current) =>
            current === undefined || (current.workflows[workflow] ?? 0) > run.runId
                ? current
                : { ...current, findings: current.findings.filter((owed) => owed.source !== workflow || kept.has(owed.id)) },
        );
    });
};

/** A finished run, from its webhook or the poller: a pass takes its workflow off main's failure, and a failure hands every
 *  failed job not yet heard of to the fixer at once, re-running a run only the fleet failed. */
export const runFinished = async (services: Services, run: PipelineRun, fetchFn: FetchFn = fetch): Promise<void> => {
    if (run.status !== "success" && run.status !== "failed") {
        return;
    }
    const project = (await ciProjects(services)).find((candidate) => candidate.repo === run.repo);
    if (project === undefined || !(await isMainLine(services, project, run.branch))) {
        return;
    }
    if (run.status === "success") {
        await passed(services, project, run);
        return;
    }
    const steps = await failedStepsOf(services, project, run, fetchFn);
    const verdicts: Verdict[] = [];
    for (const step of steps) {
        verdicts.push(await jobFailed(services, project, jobOf(run, step), fetchFn));
    }
    if (verdicts.length > 0 && verdicts.every((verdict) => verdict === "fleet")) {
        await rerunFleet(services, project, run, fetchFn);
        return;
    }
    const failing = steps.filter((_step, index) => verdicts[index] === "code").map((step) => step.job);
    if (failing.length > 0) {
        await failedRun(services, project, run, failing);
    }
    await handOverRun(services, project, run.branch, run.runId, "finished", fetchFn);
};

/** A run still going, from the poller where no webhook is live: every job that already failed is parked for the run's
 *  handover. */
export const runInFlight = async (services: Services, project: CiProject, run: PipelineRun, fetchFn: FetchFn = fetch): Promise<void> => {
    if (!(await isMainLine(services, project, run.branch))) {
        return;
    }
    for (const step of await failedStepsOf(services, project, run, fetchFn)) {
        await jobFailed(services, project, jobOf(run, step), fetchFn);
    }
};

/** A turn of some conversation settled: the fix agent's, it changed something (which is noted) or it ended in a way that
 *  hands the failure to the owner. A turn the sandbox runs again by itself is not over yet. */
export const fixerSettled = async (services: Services, settled: { readonly conversationId: string; readonly rerun?: unknown }): Promise<void> => {
    // Every fix agent is a CI fix conversation (startCiFix); any other turn is none of this.
    if (settled.rerun !== undefined || !settled.conversationId.startsWith(CI_FIX_PREFIX)) {
        return;
    }
    const found = Object.entries(await services.ciStore.failures()).find(([, streak]) => fixerOf(streak) === settled.conversationId);
    if (found === undefined) {
        return;
    }
    const [key] = found;
    const [repo = "", branch = ""] = key.split("\n");
    await serially(key, async () => {
        const streak = (await services.ciStore.failures())[key];
        const agent = services.agents.get(settled.conversationId);
        if (streak === undefined || fixerOf(streak) !== settled.conversationId || waitsForOwner(streak) || agent === undefined) {
            return;
        }
        if (agent.archivedAt !== undefined) {
            await handOver(services, repo, branch, settled.conversationId, ARCHIVED);
            return;
        }
        const stance = fixStance(agent).kind;
        if (stance === "ready" || stance === "landed") {
            if (!streak.changed) {
                await services.ciStore.failure(repo, branch, (current) => (current === undefined ? current : { ...current, changed: true }));
            }
            return;
        }
        const handBack = endedHandBack(agent, streak);
        if (handBack !== undefined) {
            await handOver(services, repo, branch, settled.conversationId, handBack);
        }
    });
};

/** A person pressed Fix on a run of a failing main-line branch: the streak's fix agent is theirs to continue, with its turns
 *  back. The id its attempts share (named for the run the streak began in, whose newest attempt the press continues),
 *  or undefined when the run is no part of a streak. */
export const streakFixerFor = async (services: Services, run: Pick<PipelineRun, "repo" | "branch">): Promise<string | undefined> => {
    // A streak is only ever begun on a main-line branch (jobFailed), so having one is the branch's answer.
    const streak = (await services.ciStore.failures())[keyOf(run.repo, run.branch)];
    return streak === undefined ? undefined : ciFixConversationId(run.repo, streak.firstRunId);
};

/** Records the press that continued a streak's fix agent: it has its turns back, and failures reach it again. */
export const fixPressed = async (services: Services, run: Pick<PipelineRun, "repo" | "branch">, conversationId: string): Promise<void> => {
    await serially(keyOf(run.repo, run.branch), async () => {
        await services.ciStore.failure(run.repo, run.branch, (current) =>
            current === undefined
                ? current
                : {
                      ...current,
                      turns: 0,
                      decisions: [
                          ...current.decisions,
                          { kind: "fix-up", conversationId, at: Date.now(), detail: "A person pressed Fix: the fix agent has its turns back." },
                      ],
                  },
        );
    });
    publishRuntimeChange("ci");
};

/** Every main-line branch failing right now, as GET /ci/runs serves it. */
export const mainFailures = async (services: Services): Promise<CiMainFailure[]> =>
    Object.entries(await services.ciStore.failures()).map(([key, streak]) => {
        const [repo = "", branch = ""] = key.split("\n");
        const decision = streak.decisions.at(-1);
        return {
            repo,
            branch,
            since: streak.since,
            runId: streak.runId,
            jobs: streak.findings.map(({ text }) => text),
            ...opt("fixer", fixerOf(streak)),
            ...opt("decision", decision),
        };
    });

/** At boot, each failure the CI store kept: its fix agent's turn may have ended while the daemon was down, and main may have
 *  failed again or passed meanwhile, which a missed webhook never said. */
export const resumeMainFixer = async (services: Services, fetchFn: FetchFn = fetch): Promise<void> => {
    const streaks = Object.entries(await services.ciStore.failures());
    if (streaks.length === 0) {
        return;
    }
    const projects = await ciProjects(services);
    for (const [key, streak] of streaks) {
        const [repo = "", branch = ""] = key.split("\n");
        const fixer = fixerOf(streak);
        if (fixer !== undefined && !services.conversations.running(fixer)) {
            await fixerSettled(services, { conversationId: fixer });
        }
        const project = projects.find((candidate) => candidate.repo === repo);
        if (project === undefined) {
            continue;
        }
        const runs = await orElse(
            services,
            ciClientFor(project.account.provider, fetchFn).listRuns(project, RUNS_LISTED),
            [],
            "ci repair: runs not listed at boot, main's failure waits for the next run",
            {
                repo,
            },
        );
        // Oldest first, as they happened.
        for (const run of runs.filter((candidate) => candidate.branch === branch && candidate.runId >= streak.firstRunId).toReversed()) {
            await (isPipelineInFlight(run.status) ? runInFlight(services, project, run, fetchFn) : runFinished(services, run, fetchFn));
        }
    }
};

/** Test seam: forget what only this process holds, as a restart does; the failures on file stay. */
export const resetMainFixer = (options: { readonly settleCapMs?: number } = {}): void => {
    locks.clear();
    fleetJobs.clear();
    for (const batch of batches.values()) {
        clearTimeout(batch.timer);
    }
    batches.clear();
    settleCapMs = options.settleCapMs ?? RUN_SETTLE_CAP_MS;
};

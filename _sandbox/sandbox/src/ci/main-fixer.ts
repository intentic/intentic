import { serialLock } from "@intentic/base/async";
import { isInfraStep } from "@intentic/constants/ci-infra-steps";
import {
    type AgentSummary,
    CI_FIX_PREFIX,
    ciFixConversationId,
    type CiMainRed,
    type Finding,
    fixStance,
    fnvDigest,
    isPipelineInFlight,
    type PipelineRun,
    type RedDecision,
} from "@intentic/sandbox-contract";
import { deliverWake } from "../agent/run/turn/wake-delivery.js";
import type { Services } from "../composition.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import { opt } from "../opt.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import type { CiRed } from "./ci-store.js";
import { FIX_LOG_BYTES, infraLog, startCiFix } from "./ci-fix.js";
import { ciProjects, type CiProject } from "./projects.js";
import { ciClientFor, type FailedStep, type FetchFn } from "./providers.js";

/* MAIN'S CI HAS ONE FIX AGENT. The first job that fails on a main-line branch starts it, with that job's log, while the
   rest of the run goes on. Every later failure on the branch, in that run or a later one, is said to the same
   conversation: into its live turn, as a turn of its own when it is idle, queued otherwise. So it never watches a run
   itself, and nobody decides who broke what. The streak ends when a later run of every workflow that failed on it
   passes.

   It gets a few turns, and hands the red to the owner when they are spent, or when its turn ends without it having
   changed anything (a failure that is not in the code: the runner's environment, a tool's version, a secret) or ends
   failed, stopped or archived. A failed job the CI fleet died in is never its work: a run whose every failure is the
   fleet's is re-run once. The streak is kept in the CI store (ci-store.ts), so a restart neither forgets it nor starts a
   second agent on it; the Agent tab's Repair switch (`autoRepair`) off, main's red is only reported. */

// Branches whose red a fix agent is for; any other branch is somebody's work in progress.
const MAIN_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);
// Turns the sandbox starts for the fix agent in one streak; words said into its live turn are none.
export const TURNS_PER_STREAK = 3;
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
    // The step it failed in, where the forge names steps (GitHub).
    readonly step?: string | undefined;
    // Why it failed, in the forge's own word, where it says (GitLab's `failure_reason`).
    readonly reason?: string | undefined;
}

// What became of one failed job: somebody's (sent, recorded, or not main's), or the fleet's.
type Verdict = "code" | "fleet" | "skipped";

// What only this process holds: a lock per branch, so one branch's news is decided in the order it arrived; the fleet
// failures already judged, so a job is not read twice for them; and the runs re-run for the fleet.
const locks = new Map<string, ReturnType<typeof serialLock>>();
const fleetJobs = new Set<string>();
const rerunOnce = new Set<string>();

const keyOf = (repo: string, branch: string): string => `${repo}\n${branch}`;
const heardOf = (job: Pick<FailedJob, "runId" | "jobId">): string => `${job.runId}/${job.jobId}`;
const workflowOf = (workflow: string | undefined): string => (workflow === undefined || workflow === "" ? ONE_PIPELINE : workflow);
const findingOf = (workflow: string, job: string): Finding => ({
    id: fnvDigest(`${workflow}\n${job}`),
    source: workflow,
    text: job,
    recheckable: true,
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
export const fixerOf = (red: CiRed): string | undefined => red.decisions.findLast((decision) => decision.kind === "fix-up")?.conversationId;
// Whether the red was handed to the owner since its fix agent was last given it.
const waitsForOwner = (red: CiRed): boolean => red.decisions.at(-1)?.kind === "spent";

const tell = (services: Services, type: string, content: string, outcome: "ok" | "error", conversationId?: string): void => {
    void orElse(
        services,
        services.activity.append({ direction: "system", type, content, outcome, ...opt("conversationId", conversationId) }),
        undefined,
        "ci repair: activity append failed",
        { type },
    );
};

const decided = async (services: Services, repo: string, branch: string, decision: RedDecision): Promise<void> => {
    await services.ciStore.red(repo, branch, (current) =>
        current === undefined ? current : { ...current, decisions: [...current.decisions, decision] },
    );
    publishRuntimeChange("ci");
};

// The red handed to the owner: nothing more is sent to its fix agent until a person presses Fix.
const handOver = async (services: Services, repo: string, branch: string, fixer: string | undefined, why: string): Promise<void> => {
    await decided(services, repo, branch, {
        kind: "spent",
        ...opt("conversationId", fixer),
        at: Date.now(),
        detail: `${why}: main's red waits for you.`,
    });
    tell(services, "ci.repair_needs_you", `${branch} of ${repo} is still red and waits for you: ${why}.`, "error", fixer);
};

// Why a fix agent's ended turn hands the red over, or undefined when it does not: a turn that changed nothing after the
// agent had changed something already found nothing left to do, and its turns are counted anyway.
const endedWhy = (agent: AgentSummary, red: CiRed): string | undefined => {
    if (fixStance(agent).kind !== "ended") {
        return undefined;
    }
    switch (agent.status) {
        case "idle":
            return red.changed
                ? undefined
                : "its fix agent finished without changing anything, so the failure is likely not in the code (the runner's environment, a tool's version, a secret)";
        case "stopped":
            return "its fix agent was stopped";
        case "interrupted":
            return "its fix agent's turn was cut off";
        default:
            return `its fix agent's turn failed${agent.failure === undefined ? "" : ` (${agent.failure})`}`;
    }
};

// The job, in the words a turn reads it by.
const where = (job: FailedJob): string =>
    `"${job.name}" in run ${job.runId}${job.step === undefined ? "" : `, at its step "${job.step}"`}${job.url === undefined ? "" : ` (${job.url})`}`;

const logBlock = (job: FailedJob, log: string): string => (log === "" ? "" : `\n\n--- job: ${job.name} (log tail) ---\n${log}`);

// What the fix agent is told first, ahead of the failure's evidence.
const openingPreface = (project: CiProject, job: FailedJob): string =>
    [
        `Main's CI went red: the job ${where(job)} failed on ${job.branch} of "${project.repo}", and the run may still be going.`,
        `You are the one fix agent for this red. Every later failure on ${job.branch}, in this run or a later one, is sent to this conversation until ${job.branch} passes again, so do not wait on the run or watch it: fix what failed, then end your turn.`,
        `Your work lands in the main tree like any conversation's; the owner commits and pushes it, and the next run on ${job.branch} measures it.`,
    ].join(" ");

// What a later failure says to the fix agent already on the streak.
const followUp = (project: CiProject, red: CiRed, job: FailedJob, log: string): string =>
    [
        `Another job failed on ${job.branch} of "${project.repo}": ${where(job)}.`,
        job.runId === red.firstRunId
            ? `It is in the run this red began in.`
            : `It is from a later run${job.sha === undefined ? "" : `, at commit ${job.sha.slice(0, 7)}`}.`,
        `If what you already changed covers it (the run's commit predates your change), say so and change nothing; otherwise fix it too, then end your turn.`,
    ].join(" ") + logBlock(job, log);

// Whether the fleet failed the job rather than the code: a runner-owned step, the forge's own reason, or a log naming
// the fleet. Missing evidence never reads as the fleet's.
const fleetFailed = (job: FailedJob, log: string): boolean =>
    (job.step !== undefined && isInfraStep(job.step)) || (job.reason !== undefined && GITLAB_FLEET_REASONS.has(job.reason)) || infraLog(log);

// The red after one more failed job: begun at it when there was none.
const withJob = (current: CiRed | undefined, job: FailedJob, now: number): CiRed => {
    const workflow = workflowOf(job.workflow);
    const red: CiRed = current ?? {
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
    const newest = red.workflows[workflow];
    const finding = findingOf(workflow, job.name);
    return {
        ...red,
        runId: Math.max(red.runId, job.runId),
        count: red.count + (newest === undefined || job.runId > newest ? 1 : 0),
        workflows: { ...red.workflows, [workflow]: Math.max(newest ?? 0, job.runId) },
        findings: red.findings.some((owed) => owed.id === finding.id) ? red.findings : [...red.findings, finding],
        heard: [...red.heard, heardOf(job)].slice(-HEARD_KEPT),
    };
};

// Puts the streak's fix agent on it: a fresh conversation named for the run the streak began in.
const startFixer = async (services: Services, project: CiProject, red: CiRed, job: FailedJob, log: string, fetchFn: FetchFn): Promise<void> => {
    const outcome = await orElse(
        services,
        startCiFix(
            services,
            {
                project,
                runId: job.runId,
                base: ciFixConversationId(project.repo, red.firstRunId),
                evidence: {
                    failedJobs: [job.name],
                    logs: log === "" ? "" : `--- job: ${job.name} (log tail) ---\n${log}`,
                    infra: false,
                    infraSteps: [],
                },
                preface: openingPreface(project, job),
            },
            fetchFn,
        ),
        undefined,
        "ci repair: the fix agent did not start",
        { repo: project.repo, runId: job.runId },
    );
    if (outcome === undefined) {
        return;
    }
    await services.ciStore.red(project.repo, job.branch, (current) =>
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
                          detail: `Its first failed job, ${job.name}, put a fix agent on it; every later failure goes to the same one.`,
                      },
                  ],
              },
    );
    publishRuntimeChange("ci");
    if (outcome.kind === "started") {
        tell(
            services,
            "ci.repair_started",
            `${job.branch} of ${project.repo} went red on ${job.name}: a fix agent is on it, and every later failure goes to it.`,
            "ok",
            outcome.conversationId,
        );
        return;
    }
    // An attempt at this streak's id was already in play (a person's press got there first): it is the fix agent, and
    // hears this failure like any later one.
    const fixer = (await services.ciStore.reds())[keyOf(project.repo, job.branch)];
    if (fixer !== undefined) {
        await sendOn(services, project, fixer, job, log);
    }
};

// Says a later failure to the streak's fix agent, or hands the red over when it can take no more.
const sendOn = async (services: Services, project: CiProject, red: CiRed, job: FailedJob, log: string): Promise<void> => {
    const fixer = fixerOf(red);
    const agent = fixer === undefined ? undefined : services.agents.get(fixer);
    const entry = fixer === undefined ? undefined : services.agents.entry(fixer);
    if (fixer === undefined || agent === undefined || entry === undefined || agent.archivedAt !== undefined) {
        await handOver(
            services,
            project.repo,
            job.branch,
            fixer,
            agent?.archivedAt === undefined ? "its fix agent is gone" : "its fix agent was archived",
        );
        return;
    }
    const ended = endedWhy(agent, red);
    if (ended !== undefined) {
        await handOver(services, project.repo, job.branch, fixer, ended);
        return;
    }
    // Only a turn the sandbox starts is counted: words said into the live one cost it none.
    if (!services.conversations.running(fixer) && red.turns >= TURNS_PER_STREAK) {
        await handOver(services, project.repo, job.branch, fixer, `its fix agent had its ${TURNS_PER_STREAK} turns and main is still red`);
        return;
    }
    const receipt = await orElse(
        services,
        deliverWake(
            { turns: services.turns, sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId) },
            {
                conversationId: fixer,
                prompt: followUp(project, red, job, log),
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
        return;
    }
    if ("why" in receipt || "invalid" in receipt) {
        await handOver(
            services,
            project.repo,
            job.branch,
            fixer,
            `its fix agent could not take the failure (${"why" in receipt ? receipt.why : receipt.invalid})`,
        );
        return;
    }
    if (receipt.delivered !== "steered") {
        await services.ciStore.red(project.repo, job.branch, (current) =>
            current === undefined ? current : { ...current, turns: current.turns + 1 },
        );
    }
};

/** One failed job of a main-line branch: begins the branch's streak, or goes to the fix agent already on it. Each job is
 *  handled once however many ways it arrives; a fleet failure, and a failure older than main's newest pass, are not the
 *  agent's. */
export const jobFailed = async (services: Services, project: CiProject, job: FailedJob, fetchFn: FetchFn = fetch): Promise<Verdict> => {
    if (!MAIN_BRANCHES.has(job.branch)) {
        return "skipped";
    }
    const key = keyOf(project.repo, job.branch);
    return serially(key, async (): Promise<Verdict> => {
        const heard = heardOf(job);
        if (fleetJobs.has(`${project.repo}/${heard}`)) {
            return "fleet";
        }
        const current = (await services.ciStore.reds())[key];
        if (current?.heard.includes(heard) === true) {
            return "code";
        }
        // A later run of its workflow already passed: older news than main's own.
        if (((await services.ciStore.greens(project.repo, job.branch))[workflowOf(job.workflow)] ?? 0) > job.runId) {
            return "skipped";
        }
        const log = await orElse(
            services,
            ciClientFor(project.account.provider, fetchFn).jobLog(project, job.jobId, FIX_LOG_BYTES),
            "",
            "ci repair: the failed job's log could not be read",
            { repo: project.repo, jobId: job.jobId },
        );
        if (fleetFailed(job, log)) {
            fleetJobs.add(`${project.repo}/${heard}`);
            return "fleet";
        }
        const red = await services.ciStore.red(project.repo, job.branch, (previous) => withJob(previous, job, Date.now()));
        publishRuntimeChange("ci");
        if (red === undefined || waitsForOwner(red)) {
            return "code";
        }
        if (!(await services.sandboxSettings.get()).autoRepair) {
            if (red.decisions.at(-1)?.kind !== "reported") {
                await decided(services, project.repo, job.branch, {
                    kind: "reported",
                    at: Date.now(),
                    detail: "Repairs are off, so nobody was sent.",
                });
            }
            return "code";
        }
        if (fixerOf(red) === undefined) {
            await startFixer(services, project, red, job, log, fetchFn);
        } else {
            await sendOn(services, project, red, job, log);
        }
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

// A run the fleet failed is re-run once; the fleet failing it again is said and left to the owner.
const rerunFleet = async (services: Services, project: CiProject, run: PipelineRun, fetchFn: FetchFn): Promise<void> => {
    const once = `${run.repo}/${run.runId}`;
    if (rerunOnce.has(once)) {
        tell(
            services,
            "ci.fleet_failed",
            `Run ${run.runId} of ${run.repo} failed on the CI fleet again after a re-run: the runners need a look, not the code.`,
            "error",
        );
        return;
    }
    rerunOnce.add(once);
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
const ended = async (services: Services, repo: string, run: PipelineRun, red: CiRed): Promise<void> => {
    await services.ciStore.red(repo, run.branch, () => undefined);
    publishRuntimeChange("ci");
    const fixer = fixerOf(red);
    const agent = fixer === undefined ? undefined : services.agents.get(fixer);
    const lastedMs = Date.now() - red.since;
    services.logger.info(
        {
            repo,
            branch: run.branch,
            lastedMs,
            runs: red.count,
            turns: red.turns,
            handedOver: red.decisions.some((decision) => decision.kind === "spent"),
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
        `${run.branch} of ${repo} passed again at ${run.sha.slice(0, 7)}, ${minutes} min and ${red.count} red run(s) after it went red${fixer === undefined ? "" : `; its fix agent took ${red.turns} turn(s)${cost}`}.`,
        "ok",
        fixer,
    );
    if (fixer !== undefined && services.conversations.running(fixer)) {
        await orElse(
            services,
            services.turns.steer(fixer, {
                text: `${run.branch} of "${repo}" passed in run ${run.runId}: main's red is over. Finish what you are doing without starting anything new.`,
                voice: "sandbox",
            }),
            false,
            "ci repair: the fix agent could not be told the red is over",
            { fixer },
        );
    }
};

// A passing run takes its workflow off the streak; the last one off ends it. A red kept before workflows were told apart
// ends at any pass.
const passed = async (services: Services, project: CiProject, run: PipelineRun): Promise<void> => {
    const workflow = workflowOf(run.workflow);
    await services.ciStore.green(project.repo, run.branch, workflow, run.runId);
    await serially(keyOf(project.repo, run.branch), async () => {
        const red = (await services.ciStore.reds())[keyOf(project.repo, run.branch)];
        if (red === undefined) {
            return;
        }
        const failing = Object.keys(red.workflows);
        const newest = red.workflows[workflow];
        if (failing.length > 0 && (newest === undefined || run.runId < newest)) {
            return;
        }
        if (failing.length > 1) {
            const { [workflow]: _passed, ...others } = red.workflows;
            await services.ciStore.red(project.repo, run.branch, (current) =>
                current === undefined
                    ? current
                    : { ...current, workflows: others, findings: current.findings.filter((owed) => owed.source !== workflow) },
            );
            publishRuntimeChange("ci");
            return;
        }
        await ended(services, project.repo, run, red);
    });
};

// A failed run's own word on its workflow: the jobs failing there now are exactly the ones it failed, when no newer run
// of the workflow has failed since.
const failedRun = async (services: Services, project: CiProject, run: PipelineRun, failing: readonly string[]): Promise<void> => {
    const workflow = workflowOf(run.workflow);
    const kept = new Set(failing.map((job) => findingOf(workflow, job).id));
    await serially(keyOf(project.repo, run.branch), async () => {
        await services.ciStore.red(project.repo, run.branch, (current) =>
            current === undefined || (current.workflows[workflow] ?? 0) > run.runId
                ? current
                : { ...current, findings: current.findings.filter((owed) => owed.source !== workflow || kept.has(owed.id)) },
        );
    });
};

/** A finished run, from its webhook or the poller: a pass takes its workflow off main's red, and a failure hands every
 *  failed job not yet heard of to the fixer, re-running a run only the fleet failed. */
export const runFinished = async (services: Services, run: PipelineRun, fetchFn: FetchFn = fetch): Promise<void> => {
    if (!MAIN_BRANCHES.has(run.branch) || (run.status !== "success" && run.status !== "failed")) {
        return;
    }
    const project = (await ciProjects(services)).find((candidate) => candidate.repo === run.repo);
    if (project === undefined) {
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
};

/** A run still going, from the poller where no webhook is live: every job that already failed goes to the fixer. */
export const runInFlight = async (services: Services, project: CiProject, run: PipelineRun, fetchFn: FetchFn = fetch): Promise<void> => {
    if (!MAIN_BRANCHES.has(run.branch)) {
        return;
    }
    for (const step of await failedStepsOf(services, project, run, fetchFn)) {
        await jobFailed(services, project, jobOf(run, step), fetchFn);
    }
};

/** A turn of some conversation settled: the fix agent's, it changed something (which is noted) or it ended in a way that
 *  hands the red to the owner. A turn the sandbox runs again by itself is not over yet. */
export const fixerSettled = async (services: Services, settled: { readonly conversationId: string; readonly rerun?: unknown }): Promise<void> => {
    // Every fix agent is a CI fix conversation (startCiFix); any other turn is none of this.
    if (settled.rerun !== undefined || !settled.conversationId.startsWith(CI_FIX_PREFIX)) {
        return;
    }
    const found = Object.entries(await services.ciStore.reds()).find(([, red]) => fixerOf(red) === settled.conversationId);
    if (found === undefined) {
        return;
    }
    const [key] = found;
    const [repo = "", branch = ""] = key.split("\n");
    await serially(key, async () => {
        const red = (await services.ciStore.reds())[key];
        const agent = services.agents.get(settled.conversationId);
        if (red === undefined || fixerOf(red) !== settled.conversationId || waitsForOwner(red) || agent === undefined) {
            return;
        }
        if (agent.archivedAt !== undefined) {
            await handOver(services, repo, branch, settled.conversationId, "its fix agent was archived");
            return;
        }
        const stance = fixStance(agent).kind;
        if (stance === "ready" || stance === "landed") {
            if (!red.changed) {
                await services.ciStore.red(repo, branch, (current) => (current === undefined ? current : { ...current, changed: true }));
            }
            return;
        }
        const why = endedWhy(agent, red);
        if (why !== undefined) {
            await handOver(services, repo, branch, settled.conversationId, why);
        }
    });
};

/** A person pressed Fix on a run of a red main-line branch: the streak's fix agent is theirs to continue, with its turns
 *  back. The id its attempts share (named for the run the streak began in, whose newest attempt the press continues),
 *  or undefined when the run is no part of a streak. */
export const streakFixerFor = async (services: Services, run: Pick<PipelineRun, "repo" | "branch">): Promise<string | undefined> => {
    if (!MAIN_BRANCHES.has(run.branch)) {
        return undefined;
    }
    const red = (await services.ciStore.reds())[keyOf(run.repo, run.branch)];
    return red === undefined ? undefined : ciFixConversationId(run.repo, red.firstRunId);
};

/** Records the press that continued a streak's fix agent: it has its turns back, and failures reach it again. */
export const fixPressed = async (services: Services, run: Pick<PipelineRun, "repo" | "branch">, conversationId: string): Promise<void> => {
    await serially(keyOf(run.repo, run.branch), async () => {
        await services.ciStore.red(run.repo, run.branch, (current) =>
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

/** Every main-line branch red right now, as GET /ci/runs serves it. */
export const mainReds = async (services: Services): Promise<CiMainRed[]> =>
    Object.entries(await services.ciStore.reds()).map(([key, red]) => {
        const [repo = "", branch = ""] = key.split("\n");
        const decision = red.decisions.at(-1);
        return {
            repo,
            branch,
            since: red.since,
            runId: red.runId,
            jobs: red.findings.map(({ text }) => text),
            ...opt("fixer", fixerOf(red)),
            ...opt("decision", decision),
        };
    });

/** At boot, each red the CI store kept: its fix agent's turn may have ended while the daemon was down, and main may have
 *  failed again or passed meanwhile, which a missed webhook never said. */
export const resumeMainFixer = async (services: Services, fetchFn: FetchFn = fetch): Promise<void> => {
    const reds = Object.entries(await services.ciStore.reds());
    if (reds.length === 0) {
        return;
    }
    const projects = await ciProjects(services);
    for (const [key, red] of reds) {
        const [repo = "", branch = ""] = key.split("\n");
        const fixer = fixerOf(red);
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
            "ci repair: runs not listed at boot, main's red waits for the next run",
            {
                repo,
            },
        );
        // Oldest first, as they happened.
        for (const run of runs.filter((candidate) => candidate.branch === branch && candidate.runId >= red.firstRunId).toReversed()) {
            await (isPipelineInFlight(run.status) ? runInFlight(services, project, run, fetchFn) : runFinished(services, run, fetchFn));
        }
    }
};

/** Test seam: forget what only this process holds, as a restart does; the reds on file stay. */
export const resetMainFixer = (): void => {
    locks.clear();
    fleetJobs.clear();
    rerunOnce.clear();
};

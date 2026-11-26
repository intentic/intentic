import { keyedLock } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { Disposable, RunSettled } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { ciFixBase, isCiFixConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import {
    type CiFailedStep,
    type CiFailure,
    type CiFeedEvent,
    type CiMainFailure,
    isPipelineInFlight,
    type MainFailureDecision,
    type MainFailureHandBack,
    type PipelineRun,
} from "@intentic/sandbox-contract/schemas/ci";
import { fixStance } from "@intentic/sandbox-contract/state/fix-stance";
import { z } from "zod";
import { runningOf } from "./agent-state.js";
import { knownConversationIds, PIPELINE_FIX, startCiFix } from "./ci-fix.js";
import type { AgentRun } from "./daemon.js";
import { digestOf, type JobExcerpt } from "./failure-digest.js";
import type { FixAttemptOutcome } from "./fix-attempts.js";
import { keepJobLog } from "./job-logs.js";
import { setDown, timedApart } from "./main-ends.js";
import { fleetOf, isFleetJob, judgedFleet, leftOut, releaseAmbiguous, rerunFleet, resetMainFleet } from "./main-fleet.js";
import {
    excerptOfJob,
    type FailedJob,
    findingOf,
    fixerOf,
    heardOf,
    isMainsOwn,
    mainFailureOf,
    withFixPressed,
    withHeard,
    withJob,
    withLearnedSpans,
    withoutStale,
    withoutWorkflow,
    withRecovered,
    workflowOf,
} from "./main-streak.js";
import { opt } from "./opt.js";
import { type CiProject, isMainLine, orElse, projectOf, type Repair, tell } from "./repair.js";

/* One persisted fix conversation per default-branch failure streak; hand a run's failed jobs over HANDOVER_DELAY_MS after the first
 * of them, or when the run finishes, whichever is sooner, and any that fail later in it as they come.
 * Send later failures to the same conversation; end the streak after every affected workflow has a later passing run.
 * Limited turns, no change, failure, stop or archive hand control to the owner. Exclude fleet failures and re-run an all-fleet-failure
 * run's failed jobs once, starting nobody, and a job that only might be the fleet's first too (main-fleet.ts).
 * Persist in this extension's record (repair-store.ts) across restarts. With autoRepair off, report failures without starting
 * repairs. (2026-11-26) The daemon's ci/main-fixer.ts until it moved into the pipelines extension: it hears CI on its event
 * stream (`api.events.onCi`: a run that finished, a job that failed with what the forge said of it), reads the forge through
 * the core's routes, and starts and tells its fix agent through POST /agent. */

// Turns the sandbox starts for the fix agent in one streak; words said into its live turn are none. A run costs one at
// most, however many of its failures are sent apart, so this is three runs' worth.
export const TURNS_PER_STREAK = 3;
// How long a failed job waits before it is handed over, so the jobs one cause fails at the same moment go as one message
// (preflight and quick on one finding, the jobs one broken install fails). It used to wait for the whole run, up to 45
// minutes: across 35 red stretches of main (2026-10-23..11-05) that held the agent back a median 14 minutes after the
// first failure, while the jobs that fail later in a run land minutes apart and are sent into its live turn for free.
export const HANDOVER_DELAY_MS = 90_000;

// What became of one failed job: somebody's (sent, recorded, or not main's), or the fleet's.
type Verdict = "code" | "fleet" | "skipped";

// One failed job parked for its run's handover, with what is kept of its log.
interface Parked {
    readonly job: FailedJob;
    readonly excerpt: JobExcerpt;
}

// A run's failed jobs heard and not yet handed over, by job id, the clock that hands them over if the run goes on, and the
// work held meanwhile, so an update waits for the handover rather than lose it (`api.work.hold`).
interface Batch {
    readonly jobs: Map<number, Parked>;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly held: Disposable;
}

// Why a run's failures are handed over now: the run finished, or it is still going and these are what failed so far.
type HandOverReason = "finished" | "early";

// What only this process holds: a lock per branch, so one branch's news is decided in the order it arrived, and each
// run's failed jobs not yet handed over (the fleet's are main-fleet.ts's).
// Losing them to a restart costs a read: `heard` is written only at a handover, so the activation's replay of the runs since
// the streak began (resumeMainFixer) parks and hands over again whatever this process held.
let serially = keyedLock<string>();
const batches = new Map<string, Batch>();
let handoverDelayMs = HANDOVER_DELAY_MS;

const keyOf = (repo: string, branch: string): string => `${repo}\n${branch}`;
const batchKeyOf = (repo: string, runId: number): string => `${repo}\n${runId}`;

// Whether the failure was handed to the owner since its fix agent was last given it.
const waitsForOwner = (streak: CiFailure): boolean => streak.decisions.at(-1)?.kind === "spent";

const decided = async (repair: Repair, repo: string, branch: string, decision: MainFailureDecision): Promise<void> => {
    await repair.store.failure(repo, branch, (current) => (current === undefined ? current : { ...current, decisions: [...current.decisions, decision] }));
};

// A batch's clock and hold, let go of.
const release = (batch: Batch): void => {
    clearTimeout(batch.timer);
    batch.held.dispose();
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
const handOver = async (repair: Repair, repo: string, branch: string, fixer: string | undefined, handBack: HandBack): Promise<void> => {
    const words = handBack.words ?? HAND_BACK[handBack.reason];
    await decided(repair, repo, branch, {
        kind: "spent",
        reason: handBack.reason,
        ...opt("conversationId", fixer),
        at: Date.now(),
        detail: `${words.charAt(0).toUpperCase()}${words.slice(1)}.`,
    });
    repair.logger.info({ repo, branch, fixer, reason: handBack.reason, ...opt("cause", handBack.cause) }, "ci repair: the failure was handed to the owner");
    tell(repair, "ci.repair_needs_you", `${branch} of ${repo} still fails and waits for you: ${words}.`, "error", fixer);
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

// What the list is: the run's whole word, or what has failed in it so far.
const completeness = (reason: HandOverReason): string =>
    reason === "finished"
        ? `The run has finished, and every verification job in it ran whatever the others concluded, so this is the whole list of what it found wrong.`
        : `The run is still going, so these are the jobs that have failed in it so far; any that fails later in it is sent to you as it fails, so start on these now.`;

// What the fix agent is told first, ahead of the failure's evidence.
const openingPreface = (project: CiProject, branch: string, runId: number, parked: readonly Parked[], reason: HandOverReason): string =>
    [
        `Main's CI is failing: ${jobsFailed(runId, parked)}, on ${branch} of "${project.repo}".`,
        completeness(reason),
        ...leftOut(fleetOf(project.repo, runId)),
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
            ...leftOut(fleetOf(project.repo, runId)),
            `If what you already changed covers them (the run's commit predates your change), say so and change nothing; otherwise fix them too, every cause, then end your turn.`,
        ].join(" "),
        `--- what failed ---\n${digestOf(parked.map(({ excerpt }) => excerpt))}`,
    ].join("\n\n");
};

// Puts the streak's fix agent on it, with every job its first failed run failed: a fresh conversation named for the run
// the streak began in. Whether the run's jobs reached it, so they are heard.
const startFixer = async (
    repair: Repair,
    project: CiProject,
    streak: CiFailure,
    branch: string,
    runId: number,
    parked: readonly Parked[],
    reason: HandOverReason,
): Promise<boolean> => {
    const names = parked.map(({ job }) => job.name);
    const outcome = await orElse(
        repair,
        (async () =>
            startCiFix(repair, {
                project,
                runId,
                base: ciFixBase(project.repo, streak.firstRunId, await knownConversationIds(repair)),
                evidence: {
                    failedJobs: names,
                    failedJobIds: parked.map(({ job }) => job.jobId),
                    logs: digestOf(parked.map(({ excerpt }) => excerpt)),
                    infra: false,
                    infraReasons: [],
                },
                preface: openingPreface(project, branch, runId, parked, reason),
            }))(),
        undefined,
        "ci repair: the fix agent did not start",
        { repo: project.repo, runId },
    );
    if (outcome === undefined) {
        return false;
    }
    await repair.store.failure(project.repo, branch, (current) =>
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
    if (outcome.kind === "started") {
        tell(
            repair,
            "ci.repair_started",
            `${branch} of ${project.repo} started failing in run ${runId}, at ${names.join(", ")}: a fix agent is on it with all of them, and every later failure goes to it.`,
            "ok",
            outcome.conversationId,
        );
        return true;
    }
    // An attempt at this streak's id was already in play (a person's press got there first): it is the fix agent, and
    // hears this run like any later one.
    const current = (await repair.store.failures())[keyOf(project.repo, branch)];
    return current === undefined ? false : sendOn(repair, project, current, branch, runId, parked, reason);
};

// A refusal the daemon answered (a conversation that will not take words), told from a door that never answered.
const AnsweredSchema = z.object({ status: z.number() });

// The words said to the fix agent as one message, through POST /agent, on its own model: its profile as its card says it,
// under this extension's job. Undefined when the daemon could not be reached, which is tried again with the next news.
const sayTo = async (repair: Repair, agent: AgentSummary, prompt: string): Promise<{ readonly delivered: string } | { readonly refused: string } | undefined> => {
    const turn: AgentRun = {
        conversationId: agent.id,
        prompt,
        agent: agent.provider,
        harness: agent.harness,
        ...opt("model", agent.model),
        ...opt("effort", agent.effort),
        job: PIPELINE_FIX,
    };
    try {
        return await repair.daemon.say(turn);
    } catch (error) {
        if (AnsweredSchema.safeParse(error).success) {
            return { refused: errorMessage(error) };
        }
        repair.logger.warn({ fixer: agent.id, err: errorMessage(error) }, "ci repair: the failure could not be said to the fix agent");
        return undefined;
    }
};

// Says a run's failures to the streak's fix agent as one message, or hands the failure over when it can take no more.
// Whether they reached it, so they are heard.
const sendOn = async (
    repair: Repair,
    project: CiProject,
    streak: CiFailure,
    branch: string,
    runId: number,
    parked: readonly Parked[],
    reason: HandOverReason,
): Promise<boolean> => {
    const fixer = fixerOf(streak);
    const agent = fixer === undefined ? undefined : await orElse(repair, repair.daemon.agent(fixer), undefined, "ci repair: the fix agent could not be read", { fixer });
    if (fixer === undefined || agent === undefined || agent.archivedAt !== undefined) {
        await handOver(repair, project.repo, branch, fixer, agent?.archivedAt === undefined ? { reason: "gone" } : ARCHIVED);
        return false;
    }
    const handBack = endedHandBack(agent, streak);
    if (handBack !== undefined) {
        await handOver(repair, project.repo, branch, fixer, handBack);
        return false;
    }
    // Only a turn the sandbox starts is counted: words said into the live one cost it none.
    if (!runningOf(agent) && streak.turns >= TURNS_PER_STREAK) {
        await handOver(repair, project.repo, branch, fixer, { reason: "turns" });
        return false;
    }
    const receipt = await sayTo(repair, agent, followUp(project, streak, branch, runId, parked, reason));
    if (receipt === undefined) {
        return false;
    }
    if ("refused" in receipt) {
        await handOver(repair, project.repo, branch, fixer, { reason: "refused", cause: receipt.refused });
        return false;
    }
    // A run whose earlier failures were already heard has had its turn: the rest of it is part of the same one.
    if (receipt.delivered !== "steered" && !streak.heard.some((heard) => heard.startsWith(`${runId}/`))) {
        await repair.store.failure(project.repo, branch, (current) => (current === undefined ? current : { ...current, turns: current.turns + 1 }));
    }
    return true;
};

// Hands a run's parked jobs over as one: to a fix agent started for them, or to the one already on the streak. Nobody is
// told when a later pass ended the failure, it waits for the owner, or repairs were switched off meanwhile.
const handOverRun = (repair: Repair, project: CiProject, branch: string, runId: number, reason: HandOverReason): Promise<void> =>
    serially(keyOf(project.repo, branch), async () => {
        const key = batchKeyOf(project.repo, runId);
        const batch = batches.get(key);
        if (batch === undefined) {
            return;
        }
        batches.delete(key);
        try {
            const parked = [...batch.jobs.values()];
            const streak = (await repair.store.failures())[keyOf(project.repo, branch)];
            if (parked.length === 0 || streak === undefined || waitsForOwner(streak) || !(await repair.autoRepair())) {
                return;
            }
            const reached =
                fixerOf(streak) === undefined
                    ? await startFixer(repair, project, streak, branch, runId, parked, reason)
                    : await sendOn(repair, project, streak, branch, runId, parked, reason);
            if (reached) {
                await repair.store.failure(project.repo, branch, (current) => (current === undefined ? current : withHeard(current, parked.map(({ job }) => job))));
            }
        } finally {
            release(batch);
        }
    });

// The label an update waiting on a run's parked failures names.
const HOLD_LABEL = "main's CI failures waiting to be handed to its fix agent";

// Parks a failed job, with what is kept of its log, for its run's handover, and starts the clock when it is the first.
const park = (repair: Repair, project: CiProject, job: FailedJob, excerpt: JobExcerpt): void => {
    const key = batchKeyOf(project.repo, job.runId);
    const batch: Batch = batches.get(key) ?? {
        jobs: new Map(),
        timer: setTimeout(() => {
            void orElse(repair, handOverRun(repair, project, job.branch, job.runId, "early"), undefined, "ci repair: a run's failures could not be handed over", {
                repo: project.repo,
                runId: job.runId,
            });
        }, handoverDelayMs),
        // Held until the handover: an update now would drop the batch, which the next activation's replay reads again.
        held: repair.hold(HOLD_LABEL),
    };
    // The clock must not keep a stopping backend alive; a restart hands the run over from the forge's own word instead.
    batch.timer.unref?.();
    batch.jobs.set(job.jobId, { job, excerpt });
    batches.set(key, batch);
};

/** One failed job of a main-line branch: begins the branch's streak, and is parked until its run is handed over to the
 *  fix agent (handOverRun). Each job is handled once however many ways it arrives; a fleet failure, and a failure older
 *  than main's newest pass, are not the agent's (main-fleet.ts). With `anyway`, one that only might be the fleet's
 *  is the agent's anyway, its run being some code's failure or one that could not be re-run. */
export const jobFailed = async (repair: Repair, project: CiProject, heardJob: FailedJob, anyway = false): Promise<Verdict> => {
    // A job's own frame may not say what set its run off; the run's own frame, kept as it was heard, does.
    const job = heardJob.trigger === undefined ? { ...heardJob, trigger: repair.knownRun(project.repo, heardJob.runId)?.trigger } : heardJob;
    if (!isMainsOwn(job.trigger) || !isMainLine(project, job.branch)) {
        return "skipped";
    }
    const key = keyOf(project.repo, job.branch);
    return serially(key, async (): Promise<Verdict> => {
        const heard = heardOf(job);
        if (isFleetJob(project.repo, job)) {
            return "fleet";
        }
        const current = (await repair.store.failures())[key];
        if (current?.heard.includes(heard) === true || batches.get(batchKeyOf(project.repo, job.runId))?.jobs.has(job.jobId) === true) {
            return "code";
        }
        // A later run of its workflow already passed: older news than main's own.
        if (((await repair.store.passes(project.repo, job.branch))[workflowOf(job.workflow)] ?? 0) > job.runId) {
            return "skipped";
        }
        // Whole, for the digest; only its end is asked whether the fleet died, as the runner says that last.
        const log = await orElse(repair, repair.daemon.jobLog(project.repo, job.jobId), "", "ci repair: the failed job's log could not be read", {
            repo: project.repo,
            jobId: job.jobId,
        });
        if (await judgedFleet(repair, project, job, log, anyway)) {
            return "fleet";
        }
        // Kept whether or not an agent is sent now: a failure waiting for the owner is the one a person then presses Fix
        // on, and that press reads the log from here (keptJobLog) instead of downloading it a second time.
        const logPath = await orElse(
            repair,
            keepJobLog(repair.logsRoot, { repo: project.repo, runId: job.runId, jobId: job.jobId, name: job.name }, log),
            undefined,
            "ci repair: the failed job's log could not be kept for its fix agent",
            { repo: project.repo, runId: job.runId, jobId: job.jobId },
        );
        const { excerpt, named } = excerptOfJob(job, log, logPath);
        const streak = await repair.store.failure(project.repo, job.branch, (previous) => withJob(previous, job, Date.now(), named));
        if (streak === undefined || waitsForOwner(streak)) {
            return "code";
        }
        if (!(await repair.autoRepair())) {
            if (streak.decisions.at(-1)?.kind !== "reported") {
                await decided(repair, project.repo, job.branch, { kind: "reported", at: Date.now(), detail: "Repairs are off, so nobody was sent." });
            }
            return "code";
        }
        park(repair, project, job, excerpt);
        return "code";
    });
};

const jobOf = (run: PipelineRun, step: CiFailedStep): FailedJob => ({
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
    trigger: run.trigger,
    annotations: step.annotations ?? [],
    runner: step.runner,
});

// The failed jobs of a run, in or out of flight; a forge that will not say leaves nothing to act on.
const failedStepsOf = (repair: Repair, project: CiProject, run: PipelineRun): Promise<readonly CiFailedStep[]> =>
    orElse(repair, repair.daemon.failedSteps(project.repo, run.runId), [], "ci repair: the run's failed jobs could not be read", { repo: project.repo, runId: run.runId });

// A passing run takes its workflow off the streak; the last one off ends it. A failure kept before workflows were told
// apart ends at any pass.
const passed = async (repair: Repair, project: CiProject, run: PipelineRun): Promise<void> => {
    const workflow = workflowOf(run.workflow);
    await repair.store.recordPass(project.repo, run.branch, workflow, run.runId);
    await serially(keyOf(project.repo, run.branch), async () => {
        const streak = (await repair.store.failures())[keyOf(project.repo, run.branch)];
        if (streak === undefined) {
            return;
        }
        const failing = Object.keys(streak.workflows);
        const newest = streak.workflows[workflow];
        // A pass of another workflow, or an older one, says nothing of what fails; the stale come off whatever passed.
        if (failing.length > 0 && (newest === undefined || run.runId < newest)) {
            await setDown(repair, project.repo, run.branch, streak, withoutStale(streak, Date.now()), { kind: "unmeasured" });
            return;
        }
        const next = failing.length === 0 ? undefined : withoutWorkflow(streak, workflow);
        await setDown(repair, project.repo, run.branch, streak, next === undefined ? undefined : withoutStale(next, Date.now()), { kind: "passed", run });
    });
};

// A failed run's own word on its workflow: the jobs failing there now are exactly the ones it failed, when no newer run
// of the workflow has failed since.
const failedRun = async (repair: Repair, project: CiProject, run: PipelineRun, failing: readonly string[]): Promise<void> => {
    const workflow = workflowOf(run.workflow);
    const kept = new Set(failing.map((job) => findingOf(workflow, job).id));
    await serially(keyOf(project.repo, run.branch), async () => {
        await repair.store.failure(project.repo, run.branch, (current) =>
            current === undefined || (current.workflows[workflow] ?? 0) > run.runId
                ? current
                : { ...current, findings: current.findings.filter((owed) => owed.source !== workflow || kept.has(owed.id)) },
        );
    });
};

/** A finished run, from its frame on the CI feed or a catch-up: a pass takes its workflow off main's failure, and a failure
 *  hands every failed job not yet heard of to the fixer at once, re-running a run only the fleet failed. */
export const runFinished = async (repair: Repair, run: PipelineRun): Promise<void> => {
    if (run.status !== "success" && run.status !== "failed" && run.status !== "canceled") {
        return;
    }
    const project = await projectOf(repair, run.repo);
    if (project === undefined || !isMainLine(project, run.branch)) {
        return;
    }
    if (!isMainsOwn(run.trigger)) {
        await notMains(repair, project, run);
        return;
    }
    if (run.status === "success") {
        await passed(repair, project, run);
        return;
    }
    const steps = await failedStepsOf(repair, project, run);
    const verdicts = new Map<number, Verdict>();
    for (const step of steps) {
        verdicts.set(step.id, await jobFailed(repair, project, jobOf(run, step)));
    }
    // Jobs that only might be the fleet's, released as such (main-fleet.ts), judged again as the agent's.
    const settle = async (released: readonly FailedJob[]): Promise<void> => {
        for (const job of released) {
            verdicts.set(job.jobId, await jobFailed(repair, project, job, true));
        }
    };
    // A run some code failed is the agent's, and is not re-run: what only might be the fleet's in it goes to the agent too.
    if ([...verdicts.values()].includes("code")) {
        await settle(releaseAmbiguous(run.repo, run.runId, steps.map(({ id }) => id)));
    }
    const failing = steps.filter((step) => verdicts.get(step.id) === "code").map((step) => step.job);
    // Only a failed run ran every verification job whatever the others concluded; a cancelled one says only what passed.
    if (run.status === "failed" && failing.length > 0) {
        await failedRun(repair, project, run, failing);
    }
    await recovered(repair, project, run);
    if (verdicts.size > 0 && [...verdicts.values()].every((verdict) => verdict === "fleet")) {
        const released = await rerunFleet(repair, project, run);
        if (released.length === 0) {
            return;
        }
        await settle(released);
    }
    await handOverRun(repair, project, run.branch, run.runId, "finished");
};

// What a run that did not pass whole still says of main's failure (main-streak.ts withRecovered): the jobs that passed
// in it are fixed, and the failure ends once no job that failed on it is left.
const recovered = async (repair: Repair, project: CiProject, run: PipelineRun): Promise<void> => {
    const passedJobs = await orElse(repair, repair.daemon.passedJobs(project.repo, run.runId), [], "ci repair: the run's passed jobs could not be read", {
        repo: project.repo,
        runId: run.runId,
    });
    await serially(keyOf(project.repo, run.branch), async () => {
        const streak = (await repair.store.failures())[keyOf(project.repo, run.branch)];
        if (streak !== undefined) {
            const next = withRecovered(streak, { workflow: workflowOf(run.workflow), runId: run.runId, passed: passedJobs }, Date.now());
            await setDown(repair, project.repo, run.branch, streak, next, { kind: "recovered", run });
        }
    });
};

// Drops the repository's jobs parked for their run's handover that `drop` names; a run's clock stops once none of its
// jobs is left.
const unpark = (repo: string, drop: (parked: Parked) => boolean): void => {
    for (const [key, batch] of batches) {
        if (!key.startsWith(`${repo}\n`)) {
            continue;
        }
        for (const [jobId, parked] of batch.jobs) {
            if (drop(parked)) {
                batch.jobs.delete(jobId);
            }
        }
        if (batch.jobs.size === 0) {
            release(batch);
            batches.delete(key);
        }
    }
};

// A run on the main line that is none of main's CI (isMainsOwn): whatever it failed is nobody's, and a job of it heard
// before its run was known for what it is (its own frame) comes off again.
const notMains = (repair: Repair, project: CiProject, run: PipelineRun): Promise<void> =>
    serially(keyOf(project.repo, run.branch), async () => {
        unpark(project.repo, ({ job }) => job.runId === run.runId);
        const streak = (await repair.store.failures())[keyOf(project.repo, run.branch)];
        const workflow = workflowOf(run.workflow);
        if (streak?.workflows[workflow] !== undefined) {
            await setDown(repair, project.repo, run.branch, streak, withoutWorkflow(streak, workflow), { kind: "unmeasured" });
        }
    });

/** A person took a workflow off a failing main-line branch, or the whole failure when none is named (the board's
 *  `forget`): what is parked of it is dropped too, and a later failure of it begins again. Whether there was anything to
 *  take off. */
export const forgetFailure = (repair: Repair, target: { readonly repo: string; readonly branch: string; readonly workflow?: string | undefined }): Promise<boolean> =>
    serially(keyOf(target.repo, target.branch), async () => {
        const streak = (await repair.store.failures())[keyOf(target.repo, target.branch)];
        const { workflow } = target;
        if (streak === undefined || (workflow !== undefined && streak.workflows[workflow] === undefined)) {
            return false;
        }
        unpark(target.repo, ({ job }) => job.branch === target.branch && (workflow === undefined || workflowOf(job.workflow) === workflow));
        await setDown(repair, target.repo, target.branch, streak, workflow === undefined ? undefined : withoutWorkflow(streak, workflow), { kind: "set-aside" });
        repair.logger.info({ repo: target.repo, branch: target.branch, workflow }, "ci repair: a person set main's failure aside");
        return true;
    });

/** A run still going: every job that already failed is parked for the run's handover. */
export const runInFlight = async (repair: Repair, project: CiProject, run: PipelineRun): Promise<void> => {
    if (!isMainLine(project, run.branch)) {
        return;
    }
    for (const step of await failedStepsOf(repair, project, run)) {
        await jobFailed(repair, project, jobOf(run, step));
    }
};

/** One frame of the CI feed: a finished run, or a job that failed with what the forge said of it (its own webhook, or
 *  the poller where none is live), which is the fix agent's at once. A job that passed, and one allowed to fail (no
 *  `failed`), is none of this. */
export const heardCi = async (repair: Repair, event: CiFeedEvent): Promise<void> => {
    if (event.kind === "run") {
        await runFinished(repair, event.run);
        return;
    }
    if (event.failed === undefined) {
        return;
    }
    const project = await projectOf(repair, event.repo);
    if (project === undefined) {
        return;
    }
    await jobFailed(repair, project, {
        runId: event.runId,
        jobId: event.failed.jobId,
        name: event.job,
        branch: event.branch,
        workflow: event.workflow,
        sha: event.sha,
        url: event.url,
        step: event.failed.step,
        steps: event.failed.steps,
        reason: event.failed.reason,
        trigger: event.failed.trigger,
        annotations: event.failed.annotations,
        runner: event.failed.runner,
    });
};

/** A turn of a conversation this extension started settled: the fix agent's, it changed something (which is noted) or it
 *  ended in a way that hands the failure to the owner. A turn the sandbox runs again by itself is not over yet: its card
 *  reads as waiting, which hands nothing back. */
export const fixerSettled = async (repair: Repair, settled: Pick<RunSettled, "conversationId">): Promise<void> => {
    // Every fix agent is a CI fix conversation (startCiFix); any other turn is none of this.
    if (!isCiFixConversationId(settled.conversationId)) {
        return;
    }
    const found = Object.entries(await repair.store.failures()).find(([, streak]) => fixerOf(streak) === settled.conversationId);
    if (found === undefined) {
        return;
    }
    const [key] = found;
    const [repo = "", branch = ""] = key.split("\n");
    await serially(key, async () => {
        const streak = (await repair.store.failures())[key];
        const agent = await orElse(repair, repair.daemon.agent(settled.conversationId), undefined, "ci repair: the fix agent could not be read", {
            fixer: settled.conversationId,
        });
        if (streak === undefined || fixerOf(streak) !== settled.conversationId || waitsForOwner(streak) || agent === undefined) {
            return;
        }
        if (agent.archivedAt !== undefined) {
            await handOver(repair, repo, branch, settled.conversationId, ARCHIVED);
            return;
        }
        const stance = fixStance(agent).kind;
        if (stance === "ready" || stance === "landed") {
            if (!streak.changed) {
                await repair.store.failure(repo, branch, (current) => (current === undefined ? current : { ...current, changed: true }));
            }
            return;
        }
        const handBack = endedHandBack(agent, streak);
        if (handBack !== undefined) {
            await handOver(repair, repo, branch, settled.conversationId, handBack);
        }
    });
};

/** A person pressed Fix on a run of a failing main-line branch: the streak's fix agent is theirs to continue, with its turns
 *  back. The id its attempts share (named for the run the streak began in, whose newest attempt the press continues),
 *  or undefined when the run is no part of a streak. */
export const streakFixerFor = async (repair: Repair, run: Pick<PipelineRun, "repo" | "branch">): Promise<string | undefined> => {
    // A streak is only ever begun on a main-line branch (jobFailed), so having one is the branch's answer.
    const streak = (await repair.store.failures())[keyOf(run.repo, run.branch)];
    return streak === undefined ? undefined : ciFixBase(run.repo, streak.firstRunId, await knownConversationIds(repair));
};

/** The branch's other failing workflows, each by its newest failed run: what a press on one run of a failing main also
 *  hands the fix agent. The banner names every workflow failing, so a press that read only the run it sat on fixed the
 *  Nightly while CI went on failing. Empty when the branch has no failure, or the run is its only workflow's. */
export const streakRunsBeside = async (
    repair: Pick<Repair, "store">,
    run: Pick<PipelineRun, "repo" | "branch" | "runId">,
): Promise<readonly { readonly workflow: string; readonly runId: number }[]> => {
    const streak = (await repair.store.failures())[keyOf(run.repo, run.branch)];
    return Object.entries(streak?.workflows ?? {})
        .filter(([, runId]) => runId !== run.runId)
        .map(([workflow, runId]) => ({ workflow, runId }));
};

/** Starts a manual attempt under the handover's lock, then records exactly which failures reached it: every job of every
 *  run its prompt carried. A busy or refused start consumes nothing; later jobs remain parked for the automatic handover. */
export const fixPressed = (
    repair: Pick<Repair, "store">,
    run: Pick<PipelineRun, "repo" | "branch">,
    jobs: readonly { readonly runId: number; readonly jobId: number }[],
    start: () => Promise<FixAttemptOutcome>,
): Promise<FixAttemptOutcome> =>
    serially(keyOf(run.repo, run.branch), async () => {
        const outcome = await start();
        if (outcome.kind === "busy") {
            return outcome;
        }
        const press = { jobs, conversationId: outcome.conversationId, at: Date.now() };
        await repair.store.failure(run.repo, run.branch, (current) => (current === undefined ? current : withFixPressed(current, press)));
        unpark(run.repo, ({ job }) => jobs.some((handed) => handed.runId === job.runId && handed.jobId === job.jobId));
        return outcome;
    });

/** Every main-line branch failing right now, as the board's runs read serves it. */
export const mainFailures = async (repair: Pick<Repair, "store">): Promise<CiMainFailure[]> => Object.entries(await repair.store.failures()).map(mainFailureOf);

// Runs listed for each main line at activation and after a gap in the event stream: what main did while this backend was
// not hearing it.
const RUNS_LISTED = 15;

// What main did while nothing was heard: each kept failure's fix agent may have ended its turn, a run may have failed or
// passed meanwhile. The runs since a streak began are read again; on a main line with none, the runs finished after the
// newest one taken are, and on one never caught up the newest is taken without reading anything (a fresh install fixes
// nothing CI failed before it).
const caughtUp = async (repair: Repair, project: CiProject, streaks: Readonly<Record<string, CiFailure>>): Promise<void> => {
    const runs = await orElse(repair, repair.daemon.listRuns(project.repo, RUNS_LISTED), [], "ci repair: runs not listed, main's failure waits for the next run", {
        repo: project.repo,
    });
    const newest = Math.max(0, ...runs.map(({ runId }) => runId));
    const taken = await repair.store.caughtUp(project.repo);
    const since = (branch: string): number | undefined => streaks[keyOf(project.repo, branch)]?.firstRunId ?? (taken === undefined ? undefined : taken + 1);
    // Oldest first, as they happened.
    for (const run of runs.filter((candidate) => isMainLine(project, candidate.branch)).toReversed()) {
        const from = since(run.branch);
        if (from === undefined || run.runId < from) {
            continue;
        }
        await (isPipelineInFlight(run.status) ? runInFlight(repair, project, run) : runFinished(repair, run));
    }
    if (newest > 0) {
        await repair.store.catchUp(project.repo, newest);
    }
};

/** At activation, and after a gap in the event stream: each failure kept, whose fix agent's turn may have ended while
 *  nothing was heard, and each main line's runs since (caughtUp). */
export const resumeMainFixer = async (repair: Repair): Promise<void> => {
    const streaks = await repair.store.failures();
    const projects = await repair.daemon.mainLines();
    for (const [key, streak] of Object.entries(streaks)) {
        const [repo = "", branch = ""] = key.split("\n");
        const fixer = fixerOf(streak);
        const agent = fixer === undefined ? undefined : await orElse(repair, repair.daemon.agent(fixer), undefined, "ci repair: the fix agent could not be read", { fixer });
        if (fixer !== undefined && (agent === undefined || !runningOf(agent))) {
            await fixerSettled(repair, { conversationId: fixer });
        }
        const project = projects.find((candidate) => candidate.repo === repo);
        if (project === undefined) {
            continue;
        }
        // A failure kept before workflows were timed apart learns its times from the forge, once.
        const learned = await timedApart(repair, project, branch, streak);
        await serially(key, async () => {
            const current = (await repair.store.failures())[key];
            if (current !== undefined) {
                await setDown(repair, repo, branch, current, withLearnedSpans(current, learned, Date.now()), { kind: "unmeasured" });
            }
        });
    }
    for (const project of projects) {
        await caughtUp(repair, project, streaks);
    }
};

/** The newest run whose news was taken for its repository, so the next catch-up starts after it. */
export const taken = (repair: Pick<Repair, "store">, event: CiFeedEvent): Promise<void> =>
    event.kind === "run" && !isPipelineInFlight(event.run.status) ? repair.store.catchUp(event.run.repo, event.run.runId) : Promise.resolve();

/** Test seam, and the deactivation's: forget what only this process holds, as a restart does; the failures on file stay. */
export const resetMainFixer = (options: { readonly handoverDelayMs?: number } = {}): void => {
    serially = keyedLock<string>();
    resetMainFleet();
    for (const batch of batches.values()) {
        release(batch);
    }
    batches.clear();
    handoverDelayMs = options.handoverDelayMs ?? HANDOVER_DELAY_MS;
};

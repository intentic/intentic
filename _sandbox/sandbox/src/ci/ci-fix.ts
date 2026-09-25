import { ciFixConversationId, type PipelineRun } from "@intentic/sandbox-contract";
import { isInfraStep } from "@intentic/constants/ci-infra-steps";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import type { TurnInput } from "../seams/turn-starter.js";
import { daemonFixAttemptDeps, type FixAttemptOutcome, startFixAttempt } from "../agents/fix/fix-attempts.js";
import type { CiProject } from "./projects.js";
import { ciClientFor, type FailedStep, type FetchFn } from "./providers.js";

// One way to put an agent on a failed run, whoever asks: the Pipelines board's Fix press, or the repair gate once main has
// stayed red on the same failure (repair-gate.ts).

// Failed-job log tail seeded into a fix conversation: enough to see the error, not to flood the context.
const FIX_LOG_BYTES = 24_000;
const TITLE_MAX = 80;
const RUNS_PER_PROJECT = 15;

// Lines only the runner, its Docker daemon or its disk print; a test's own output (a refused port, an HTTP 503 it asserts)
// is left to read as the code's.
const INFRA_LOG = [
    /Cannot connect to the Docker daemon at /,
    /docker: command not found/,
    /no space left on device/i,
    /net\/http: timeout awaiting response headers/,
    /The runner has received a shutdown signal/,
    /lost communication with the server/i,
];

// Whether a failed-job log reads as the fleet's failure; any one sign is enough, since a code failure prints none of them.
export const infraLog = (logs: string): boolean => INFRA_LOG.some((sign) => sign.test(logs));

export interface CiFailureEvidence {
    readonly failedJobs: readonly string[];
    readonly logs: string;
    // Every failure died in a runner-owned step, or its log names the fleet: nothing an agent on the code can fix.
    readonly infra: boolean;
    // The runner-owned steps it died in, for saying so.
    readonly infraSteps: readonly string[];
}

// What a fix conversation is handed about a failed run, and whether the run failed on the fleet rather than the code.
// Each read that fails is logged and left out; missing evidence never reads as the fleet's failure.
export const ciFailureEvidence = async (project: CiProject, runId: number, logger: Logger, fetchFn: FetchFn = fetch): Promise<CiFailureEvidence> => {
    const client = ciClientFor(project.account.provider, fetchFn);
    const missing =
        <T>(what: string, empty: T) =>
        (error: unknown): T => {
            logger.warn({ err: error, repo: project.repo, runId }, `ci fix: the run's ${what} could not be read`);
            return empty;
        };
    const [failedJobs, failedSteps, logs] = await Promise.all([
        client.failedJobs(project, runId).catch(missing<readonly string[]>("failed jobs", [])),
        client.failedSteps(project, runId).catch(missing<readonly FailedStep[]>("failed steps", [])),
        client.failedJobLogs(project, runId, FIX_LOG_BYTES).catch(missing("failed job logs", "")),
    ]);
    const stepsOnly = failedSteps.length > 0 && failedSteps.every(({ step }) => step !== undefined && isInfraStep(step));
    return {
        failedJobs,
        logs,
        infra: stepsOnly || infraLog(logs),
        infraSteps: [...new Set(failedSteps.flatMap(({ step }) => (step === undefined ? [] : [step])))],
    };
};

export interface CiFixRequest {
    readonly project: CiProject;
    readonly runId: number;
    readonly evidence: CiFailureEvidence;
    // What the turn carries besides its words: the pick, who pressed, the resume verb.
    readonly turn?: Omit<TurnInput, "prompt" | "conversationId" | "title" | "isolated" | "runRole">;
    // Somebody pressed Fix, rather than the repair gate starting it.
    readonly byPerson: boolean;
    // Whether a model was picked for this press, which outranks re-running a turn the door kept.
    readonly picked?: boolean;
    readonly resume?: Parameters<typeof startFixAttempt>[1]["resume"];
    // Said first in the opening prompt, when whoever started it knows something the logs do not.
    readonly preface?: string;
}

const promptOf = (request: CiFixRequest, where: string): string =>
    [
        ...(request.preface === undefined ? [] : [request.preface]),
        `The CI pipeline for the workspace repo "${request.project.repo}" failed ${where}. Investigate and fix it.`,
        ...(request.evidence.failedJobs.length > 0 ? [`Failed jobs: ${request.evidence.failedJobs.join(", ")}.`] : []),
        `The logs below are the evidence — read them first; they are usually enough to name the cause.`,
        `REPRODUCE LOCALLY ONLY IF THIS SANDBOX CAN, AND ONLY WHAT FAILED. Re-run the failing job's own step for the package it names (that package's tests or typecheck, the failing test files alone), never the whole repository's suite: this sandbox is shared with other conversations, and a repository-wide run takes the memory they need. Jobs that need Docker, a fresh CI image, a desktop runner, a GPU, Windows or Xcode DO NOT: this sandbox has none of them, and an hour spent standing one up is an hour that ends in a guess anyway.`,
        `For a job you cannot run here: make the change from the logs, then verify it in the place the constraints exist by dispatching the workflow on your own branch and reading the run it starts. NO \`gh\` OR \`glab\` IS INSTALLED IN THIS SANDBOX — the ${request.project.account.provider} REST API is how you reach the run, and the \`${request.project.account.provider}\` skill carries the connected token and the curl form for it. The same API serves a failed job's full log, which is worth fetching when the tail below cuts off the cause. Say plainly in your summary if you could not verify it and what would.`,
        `You are in an isolated worktree: commit your fix and it goes through review.`,
        ...(request.evidence.logs !== "" ? [`--- failed job logs (tails) ---\n${request.evidence.logs}`] : []),
    ].join("\n\n");

// Starts, continues or declines an attempt at a failed run; attempts share an id derived from the run, so the board groups them.
export const startCiFix = async (services: Services, request: CiFixRequest, fetchFn: FetchFn = fetch): Promise<FixAttemptOutcome> => {
    const { project, runId } = request;
    const client = ciClientFor(project.account.provider, fetchFn);
    // Usually already in the cache, from the view the click came from; a cold daemon re-lists instead.
    const run: PipelineRun | undefined =
        (services.ciRuns.sweep() ?? []).find((candidate) => candidate.repo === project.repo && candidate.runId === runId) ??
        (
            await client.listRuns(project, RUNS_PER_PROJECT).catch((error: unknown) => {
                services.logger.warn({ err: error, repo: project.repo, runId }, "ci fix: the project's runs could not be listed");
                return [];
            })
        ).find((candidate) => candidate.runId === runId);
    const where = run !== undefined ? `on branch ${run.branch} (${run.url})` : `(run ${runId})`;
    // What a CONTINUED attempt is told: the failure is still open, the evidence is already in the conversation.
    const nudge = [
        `The CI failure on "${project.repo}" ${where} is still open, and this conversation is the attempt at it. Your earlier turn ended without landing a fix.`,
        `Carry on from where you left off; the failed job logs earlier in this conversation are still the evidence. You are in an isolated worktree: commit your fix and it goes through review.`,
    ].join("\n\n");
    return startFixAttempt(
        daemonFixAttemptDeps(services, { byPerson: request.byPerson, picked: request.picked === true }),
        {
            base: ciFixConversationId(project.repo, runId),
            prompt: promptOf(request, where),
            nudge,
            title: `Fix CI: ${run?.title ?? project.repo}`.slice(0, TITLE_MAX),
            // `runRole` alone is what pins the model (turn-resume.ts); the pick and who pressed ride in `turn`.
            turn: { isolated: true, runRole: `pipeline-fix`, ...request.turn },
            resume: request.resume,
        },
    );
};

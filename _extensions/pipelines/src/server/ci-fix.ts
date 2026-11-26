import { errorMessage } from "@intentic/base/errors";
import type { ExtensionCaller } from "@intentic/extension-api";
import { ciFixBase, ciFixTitle } from "@intentic/sandbox-contract/ids/conversation-ids";
import { CI_OWNER_STEP_MARK, type CiFailedStep, isCiInfraStep, type PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { AgentRun } from "./daemon.js";
import { digestOf, excerptOf } from "./failure-digest.js";
import { extensionFixAttemptDeps, type FixAttemptOutcome, startFixAttempt } from "./fix-attempts.js";
import { jobVerdict } from "./fleet-verdict.js";
import { jobLogPath, keepJobLog, keptJobLog } from "./job-logs.js";
import type { CiProject, Repair } from "./repair.js";

// One way to put an agent on a failed run, whoever asks: the Pipelines board's Fix press, or main's one fix agent with
// the first run that fails on a main-line branch (main-fixer.ts). (2026-11-26) The daemon's ci/ci-fix.ts until main's
// fix agent moved into this extension: the forge is read through the core's routes, and the turn starts through
// POST /agent under this extension's `pipeline-fix` job.

// How much of a failed job's log end is read for the fleet's signs (fleet-verdict.ts): the runner's death is said last.
export const FIX_LOG_BYTES = 24_000;
// A failed job's log is read whole (POST /ci/jobs/log), since its errors can sit anywhere in it (a typecheck's above a test
// run's megabytes), and only its digest (failure-digest.ts) reaches a conversation.
const RUNS_PER_PROJECT = 15;

// Why a run reads as the fleet's, in words for whoever pressed Fix: what each job's annotations, the forge's reason or
// its log end say the fleet did (fleet-verdict.ts), with the jobs it did it to, or, when none says so, the runner-owned
// steps every job died in. Empty when the run reads as the code's.
export const fleetReasons = (failedSteps: readonly CiFailedStep[], logs: readonly string[]): readonly string[] => {
    const jobsBySign = new Map<string, string[]>();
    failedSteps.forEach((failed, index) => {
        // Its own steps alone: a runner-owned one is the fallback's below, said once for the run.
        const verdict = jobVerdict(
            { steps: failed.steps ?? [], reason: failed.reason, annotations: failed.annotations },
            (logs[index] ?? "").slice(-FIX_LOG_BYTES),
        );
        if (verdict.kind === "fleet") {
            jobsBySign.set(verdict.says, [...(jobsBySign.get(verdict.says) ?? []), failed.job]);
        }
    });
    if (jobsBySign.size > 0) {
        return [...jobsBySign].map(([says, jobs]) => `${says} (${jobs.join(", ")})`);
    }
    const stepsOnly = failedSteps.length > 0 && failedSteps.every(({ step }) => step !== undefined && isCiInfraStep(step));
    if (!stepsOnly) {
        return [];
    }
    const steps = [...new Set(failedSteps.flatMap(({ step }) => (step === undefined ? [] : [step])))];
    return [`every failed job died in the runner's own steps (${steps.join(", ")})`];
};

export interface CiFailureEvidence {
    readonly failedJobs: readonly string[];
    // The exact snapshot handed to a manual fix, so its later automatic handover sends only additional failures.
    readonly failedJobIds: readonly number[];
    // What failed, read out of the failed jobs' logs (failure-digest.ts): every error once with the jobs that printed it,
    // then each failed step's last lines.
    readonly logs: string;
    // Every failure died in a runner-owned step, or a log names the fleet: nothing an agent on the code can fix.
    readonly infra: boolean;
    // Why it reads as the fleet's (fleetReasons), for saying so; empty when infra is false.
    readonly infraReasons: readonly string[];
}

// What a fix conversation is handed about a failed run, and whether the run failed on the fleet rather than the code.
// Each read that fails is logged and left out; missing evidence never reads as the fleet's failure.
export const ciFailureEvidence = async (repair: Pick<Repair, "daemon" | "logger" | "logsRoot">, project: CiProject, runId: number): Promise<CiFailureEvidence> => {
    const missing =
        <T>(what: string, empty: T) =>
        (error: unknown): T => {
            repair.logger.warn({ err: errorMessage(error), repo: project.repo, runId }, `ci fix: the run's ${what} could not be read`);
            return empty;
        };
    const failedSteps = await repair.daemon.failedSteps(project.repo, runId).catch(missing<readonly CiFailedStep[]>("failed steps", []));
    const root = repair.logsRoot;
    const jobOf = (failed: CiFailedStep) => ({ repo: project.repo, runId, jobId: failed.id, name: failed.job });
    // Every failed job's log, whole and side by side: the one an earlier read kept (keptJobLog), else the forge's. One that
    // cannot be read is left out, and only its end is asked whether the fleet died.
    const reread = await Promise.all(failedSteps.map((failed) => keptJobLog(root, jobOf(failed)).catch(missing(`kept log of ${failed.job}`, undefined))));
    const logs = await Promise.all(
        failedSteps.map((failed, index) => reread[index] ?? repair.daemon.jobLog(project.repo, failed.id).catch(missing(`log of ${failed.job}`, ""))),
    );
    const infraReasons = fleetReasons(failedSteps, logs);
    // Each whole log is kept where the agent can read it (job-logs.ts), unless it was read from there; one that cannot be
    // written is left unnamed.
    const kept = await Promise.all(
        failedSteps.map((failed, index) =>
            reread[index] !== undefined
                ? jobLogPath(root, project.repo, runId, failed.id, failed.job)
                : keepJobLog(root, jobOf(failed), logs[index] ?? "").catch(missing<string | undefined>(`kept copy of ${failed.job}'s log`, undefined)),
        ),
    );
    return {
        failedJobs: failedSteps.map(({ job }) => job),
        failedJobIds: failedSteps.map(({ id }) => id),
        logs: digestOf(
            failedSteps.map((failed, index) =>
                excerptOf({
                    name: failed.job,
                    steps: failed.steps ?? (failed.step === undefined ? [] : [failed.step]),
                    log: logs[index] ?? "",
                    logPath: kept[index],
                }),
            ),
        ),
        infra: infraReasons.length > 0,
        infraReasons,
    };
};

// One failing workflow's evidence, read off its newest failed run.
export interface WorkflowEvidence {
    readonly workflow: string;
    readonly runId: number;
    readonly url: string | undefined;
    readonly evidence: CiFailureEvidence;
}

// What a failing main hands its fix agent when several workflows fail on it at once: every one's jobs and logs, each
// under its workflow's name and run, since a fix for the pressed run's workflow alone leaves the branch failing. The
// fleet's only when every run is: one code failure among them is still the agent's to fix. One workflow is its own.
export const jointEvidence = (parts: readonly WorkflowEvidence[]): CiFailureEvidence => {
    const [only] = parts;
    if (parts.length === 1 && only !== undefined) {
        return only.evidence;
    }
    const named = (part: WorkflowEvidence): string => `${part.workflow} (run ${part.runId}${part.url === undefined ? "" : `, ${part.url}`})`;
    return {
        failedJobs: parts.flatMap((part) => part.evidence.failedJobs.map((job) => `${job} in ${part.workflow}`)),
        failedJobIds: parts.flatMap((part) => part.evidence.failedJobIds),
        logs: parts
            .filter((part) => part.evidence.logs !== "")
            .map((part) => `=== ${named(part)} ===\n${part.evidence.logs}`)
            .join("\n\n"),
        infra: parts.length > 0 && parts.every((part) => part.evidence.infra),
        infraReasons: parts.flatMap((part) => (part.evidence.infra ? part.evidence.infraReasons.map((reason) => `${part.workflow}: ${reason}`) : [])),
    };
};

export interface CiFixRequest {
    readonly project: CiProject;
    readonly runId: number;
    // The failure the attempts are at, which the first wears as its id: the run's own (ciFixBase) unless the run
    // is part of a failing streak on main, whose one fix agent every failure goes to.
    readonly base?: string;
    // The run, when the caller already read it; looked up otherwise.
    readonly run?: PipelineRun | undefined;
    readonly evidence: CiFailureEvidence;
    // What the turn carries besides its words: the caret's pick and a booking for a spent allowance's reopen.
    readonly turn?: Omit<AgentRun, "prompt" | "conversationId" | "title" | "isolated" | "job">;
    // Whoever pressed Fix, as the daemon vouched for them: the conversation is theirs. Absent: main's fix agent started
    // by itself, as the extension.
    readonly pressedBy?: ExtensionCaller | undefined;
    readonly resume?: Parameters<typeof startFixAttempt>[1]["resume"];
    // Said first in the opening prompt, when whoever started it knows something the logs do not.
    readonly preface?: string;
}

// How the forge's API is reached from here. The token variable holds a placeholder that only the credential gateway
// swaps for the real token, so the same request sent straight to the forge answers a bare 401: three fix agents spent
// four to six calls each on \`Bad credentials\` from api.github.com before finding the gateway's address.
const GATEWAY_VARIABLES = { github: "GITHUB_API_URL", gitlab: "GITLAB_URL" } as const;
const gatewayNote = (provider: keyof typeof GATEWAY_VARIABLES): string =>
    `Send every API request to the credential gateway's address in \`$${GATEWAY_VARIABLES[provider]}_<CONNECTION>\` (\`env | grep ^${GATEWAY_VARIABLES[provider]}_\` lists them; for a connection named github: \`curl -s -H "Authorization: Bearer $GITHUB_TOKEN_GITHUB" "$GITHUB_API_URL_GITHUB/repos/<owner>/<repo>/actions/runs/<id>/jobs"\`), never to the forge's own host: the token variable holds a placeholder the gateway swaps for the real token, and sent anywhere else it answers 401 Bad credentials.`;

// What no commit fixes (owner-steps.ts): a refusal that names a dashboard, a secret or an account. Said to every attempt,
// fresh or continued, since a "fix it and commit" ask is what made three agents land a docs line as a store's fix.
const OUTSIDE_THE_REPO = `IF THE CAUSE IS OUTSIDE THIS REPOSITORY (a field in a store's or vendor's dashboard, a secret's value, an account or billing setting, a service that is down), no commit fixes it, so make none for its sake: a change landed as "the fix" tells the Pipelines board the failure is handled when it is not. Confirm the cause from the logs or the API, change the repository only where that genuinely helps too, then begin your final message with one line \`${CI_OWNER_STEP_MARK} <exactly what the owner has to do, and where>\`, and say how to re-run the failed run afterwards. The board shows that line on the failed run and offers Re-run.`;

// The main line's next run is the fix's proof. Told to verify by "dispatching the workflow on your own branch", fix agents
// pushed agent/fix-* and dispatched the whole push pipeline there: a branch dispatch has no base, so every package ran,
// nothing it proved could release, and the owner's push ran it all again (2026-11-25). The owner chose no branch runs at
// all: a scheduled tier's fix is proved by its next run on the main line.
const BRANCH_RUNS = `NEVER RUN CI ON YOUR BRANCH. Do not push your branch and do not dispatch any workflow on it: the owner commits and pushes your landed fix, and the main line's next run is its proof and the only run that can release. A branch run repeats that work with nothing to show for it. For a job you cannot run here, make the change from the logs and the failure's evidence, then end your turn. Say plainly in your summary what you verified here and what only the main line's next run will show (for a scheduled or nightly job, its next run on the main line).`;

const promptOf = (request: CiFixRequest, where: string): string =>
    [
        ...(request.preface === undefined ? [] : [request.preface]),
        `The CI pipeline for the workspace repo "${request.project.repo}" failed ${where}. Investigate and fix it.`,
        ...(request.evidence.failedJobs.length > 0 ? [`Failed jobs: ${request.evidence.failedJobs.join(", ")}.`] : []),
        `What failed is below, read out of the failed jobs' logs: how failed tasks ended (an exit code that is a signal's, a heap that ran out, a memory ceiling's kill, a timeout), every error once with every job that printed it (one cause often fails several jobs), then each failed step's last lines with the passing tests left out. Read it first; it is usually enough to name each cause. Fix every cause in it, not only the first. Each job's whole log is kept on this machine at the path its \`whole log:\` line names: search that file (\`rg -n 'heap|Killed|exit code|\\(fail\\)' <path>\`) before re-running anything to find out why a task failed.`,
        `REPRODUCE LOCALLY ONLY IF THIS SANDBOX CAN, AND ONLY WHAT FAILED. Re-run the failing job's own step for the package it names (that package's tests or typecheck, the failing test files alone), never the whole repository's suite: this sandbox is shared with other conversations, and a repository-wide run takes the memory they need. Jobs that need Docker, a fresh CI image, a desktop runner, a GPU, Windows or Xcode DO NOT: this sandbox has none of them, and an hour spent standing one up is an hour that ends in a guess anyway.`,
        BRANCH_RUNS,
        `NO \`gh\` OR \`glab\` IS INSTALLED IN THIS SANDBOX — the ${request.project.host} REST API is how you reach a run, and the \`${request.project.host}\` skill carries the connected token and the curl form for it. ${gatewayNote(request.project.host)}`,
        OUTSIDE_THE_REPO,
        `You are in an isolated worktree: commit your fix and it goes through review.`,
        ...(request.evidence.logs !== "" ? [`--- what failed ---\n${request.evidence.logs}`] : []),
    ].join("\n\n");

// One run of a project: one the CI feed told of, else the core's picture of the board (usually fresh, from the view a
// click came from), else the project's newest runs asked of the forge.
export const runOf = async (repair: Pick<Repair, "daemon" | "logger" | "knownRun">, project: CiProject, runId: number): Promise<PipelineRun | undefined> => {
    const known = repair.knownRun(project.repo, runId);
    if (known !== undefined) {
        return known;
    }
    const pictured = await repair.daemon.runs().then(
        (answer) => answer.runs,
        () => [],
    );
    const found = pictured.find((candidate) => candidate.repo === project.repo && candidate.runId === runId);
    if (found !== undefined) {
        return found;
    }
    try {
        return (await repair.daemon.listRuns(project.repo, RUNS_PER_PROJECT)).find((candidate) => candidate.runId === runId);
    } catch (error) {
        repair.logger.warn({ err: errorMessage(error), repo: project.repo, runId }, "ci fix: the project's runs could not be listed");
        return undefined;
    }
};

// Every conversation id the sandbox knows, archived ones included: what decides which spelling a run's fix attempts share
// (ciFixBase), since a failure fixed before the ids were shortened keeps the family it began.
export const knownConversationIds = async (repair: Pick<Repair, "daemon">): Promise<string[]> => [
    ...(await repair.daemon.roster()).map((agent) => agent.id),
    ...(await repair.daemon.archivedIds()),
];

// Starts, continues or declines an attempt at a failed run; attempts share an id derived from the run (or the streak it is
// part of), so the board groups them. The model is the `pipeline-fix` job's (the Models page's setup for it, this
// extension's declared suggestion where the owner placed none), unless a pick names one: POST /agent's `job` decides.
export const startCiFix = async (repair: Repair, request: CiFixRequest): Promise<FixAttemptOutcome> => {
    const { project, runId } = request;
    const run = request.run ?? (await runOf(repair, project, runId));
    const where = run !== undefined ? `on branch ${run.branch} (${run.url})` : `(run ${runId})`;
    // A continued attempt also receives this press's evidence: newer failures may never have reached its earlier turn.
    const nudge = [
        `The CI failure on "${project.repo}" ${where} is still open, and this conversation is the attempt at it. Your earlier turn ended without landing a fix.`,
        `Carry on from where you left off, using the current failed job evidence below alongside the earlier conversation. Fix every cause it reports. You are in an isolated worktree: commit your fix and it goes through review.`,
        OUTSIDE_THE_REPO,
        ...(request.evidence.failedJobs.length > 0 ? [`Failed jobs: ${request.evidence.failedJobs.join(", ")}.`] : []),
        ...(request.evidence.logs !== "" ? [`--- what failed ---\n${request.evidence.logs}`] : []),
    ].join("\n\n");
    return startFixAttempt(extensionFixAttemptDeps(repair.daemon, request.pressedBy), {
        base: request.base ?? ciFixBase(project.repo, runId, await knownConversationIds(repair)),
        prompt: promptOf(request, where),
        nudge,
        title: ciFixTitle({ title: run?.title, repo: project.repo }),
        turn: { ...request.turn, isolated: true, job: PIPELINE_FIX },
        resume: request.resume,
    });
};

// The job its turns run as, this extension's own (`contributes.modelRoles`).
export const PIPELINE_FIX = "pipeline-fix";

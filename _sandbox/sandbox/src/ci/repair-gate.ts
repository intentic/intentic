import { ciFixConversationId, fixStance, type PipelineRun } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { type CiFailureEvidence, ciFailureEvidence, startCiFix } from "./ci-fix.js";
import { ciProjects, type CiProject } from "./projects.js";
import { ciClientFor, type FetchFn } from "./providers.js";

// Main's CI red is repaired only once it is main's newest word: a fleet failure is re-run once, and a code failure gets one
// fix agent when the same jobs fail twice running or main sits red with nothing newer for QUIET_MS. Memory is in-process;
// a restart forgets a streak, and the next red on main starts one again.

// How long a red main stands with nothing newer before a fix starts on it; a push inside the window is a newer run.
export const QUIET_MS = 30 * 60_000;
// Branches whose red a repair is for; any other branch is somebody's work in progress.
const MAIN_BRANCHES = new Set(["main", "master"]);
// Runs listed when asking whether anything newer stands on the branch.
const RUNS_LISTED = 15;

// A red that main has stood on: the jobs its newest run failed, how many runs running failed overlapping jobs, the run the
// streak began with (the fix's id) and its newest run.
export interface RedStreak {
    readonly jobs: readonly string[];
    readonly runs: number;
    readonly firstRunId: number;
    readonly runId: number;
}

// One completed red run's effect on the streak before it: continued when any failed job repeats, begun again otherwise.
export const nextStreak = (previous: RedStreak | undefined, runId: number, jobs: readonly string[]): RedStreak =>
    previous !== undefined && jobs.some((job) => previous.jobs.includes(job))
        ? { jobs, runs: previous.runs + 1, firstRunId: previous.firstRunId, runId }
        : { jobs, runs: 1, firstRunId: runId, runId };

interface Standing {
    streak: RedStreak;
    evidence: CiFailureEvidence;
    readonly project: CiProject;
    readonly branch: string;
    timer?: NodeJS.Timeout;
    started?: string;
}

const standing = new Map<string, Standing>();
// Runs already re-run for the fleet, so a second fleet failure on the same run is said rather than re-run forever.
const rerunOnce = new Set<string>();

const keyOf = (repo: string, branch: string): string => `${repo}\n${branch}`;

const tell = (services: Services, type: string, content: string, outcome: "ok" | "error" = "ok"): void => {
    void services.activity
        .append({ direction: "system", type, content, outcome })
        .catch((error: unknown) => services.logger.warn({ err: error, type }, "ci repair: activity append failed"));
};

// Whether a fix for this repo is already the live answer to some failure; one agent on main's CI at a time.
const fixInFlight = (services: Services, repo: string): boolean => {
    const prefix = ciFixConversationId(repo, 0).slice(0, -1);
    return services.agents.list().some((agent) => agent.id.startsWith(prefix) && fixStance(agent).ongoing);
};

// Starts the fix once nothing newer stands on the branch and no fix is already on it.
const act = async (services: Services, key: string, fetchFn: FetchFn): Promise<void> => {
    const entry = standing.get(key);
    if (entry === undefined || entry.started !== undefined || !(await services.sandboxSettings.get()).autoRepair) {
        return;
    }
    // Unlisted runs cannot show this is still the newest word, so no fix starts on them.
    const runs = await ciClientFor(entry.project.account.provider, fetchFn)
        .listRuns(entry.project, RUNS_LISTED)
        .catch((error: unknown) => {
            services.logger.warn({ err: error, repo: entry.project.repo }, "ci repair: runs not listed, the fix waits for the next red run");
            return undefined;
        });
    if (runs === undefined) {
        return;
    }
    const newest = runs.filter((run) => run.branch === entry.branch).toSorted((left, right) => right.createdAt - left.createdAt)[0];
    if ((newest !== undefined && newest.runId !== entry.streak.runId) || fixInFlight(services, entry.project.repo)) {
        return;
    }
    const outcome = await startCiFix(
        services,
        {
            project: entry.project,
            runId: entry.streak.firstRunId,
            evidence: entry.evidence,
            byPerson: false,
            preface: `Nobody pressed Fix: ${entry.branch} has stayed red on this failure for ${entry.streak.runs} run(s) and nothing newer is running, so this is the failure ${entry.branch} stands on. The logs are from its newest run, ${entry.streak.runId}.`,
        },
        fetchFn,
    ).catch((error: unknown) => {
        services.logger.warn({ err: error, repo: entry.project.repo }, "ci repair: the fix did not start");
        return undefined;
    });
    if (outcome?.kind === "started") {
        entry.started = outcome.conversationId;
        tell(services, "ci.repair_started", `${entry.branch} of ${entry.project.repo} stayed red on ${entry.streak.jobs.join(", ")}: a fix agent is on it.`);
    }
};

// A red run on the fleet is re-run once; a second fleet failure is said and left to the owner.
const rerunFleet = async (services: Services, project: CiProject, run: PipelineRun, fetchFn: FetchFn): Promise<void> => {
    const once = keyOf(run.repo, String(run.runId));
    if (rerunOnce.has(once)) {
        tell(services, "ci.fleet_failed", `Run ${run.runId} of ${run.repo} failed on the CI fleet again after a re-run: the runners need a look, not the code.`, "error");
        return;
    }
    rerunOnce.add(once);
    await ciClientFor(project.account.provider, fetchFn)
        .rerun(project, run.runId)
        .then(() => tell(services, "ci.fleet_rerun", `Run ${run.runId} of ${run.repo} failed on the CI fleet, not in the code: re-run once.`))
        .catch((error: unknown) => services.logger.warn({ err: error, runId: run.runId }, "ci repair: the fleet re-run was refused"));
};

// The branch's standing after one more red run; a fix already started stays attached while the streak it answers runs on.
const standingAfter = (previous: Standing | undefined, run: PipelineRun, evidence: CiFailureEvidence, project: CiProject): Standing => {
    const streak = nextStreak(previous?.streak, run.runId, evidence.failedJobs.length > 0 ? evidence.failedJobs : (run.failedJobs ?? []));
    const started = previous?.started !== undefined && streak.firstRunId === previous.streak.firstRunId ? previous.started : undefined;
    return { streak, evidence, project, branch: run.branch, ...(started === undefined ? {} : { started }) };
};

// A red run on the main line extends or begins its streak, and either acts now or waits out the quiet window.
const reddened = async (services: Services, run: PipelineRun, fetchFn: FetchFn): Promise<void> => {
    const project = (await ciProjects(services)).find((candidate) => candidate.repo === run.repo);
    if (project === undefined || !(await services.sandboxSettings.get()).autoRepair) {
        return;
    }
    const evidence = await ciFailureEvidence(project, run.runId, services.logger, fetchFn);
    if (evidence.infra) {
        await rerunFleet(services, project, run, fetchFn);
        return;
    }
    const key = keyOf(run.repo, run.branch);
    const previous = standing.get(key);
    clearTimeout(previous?.timer);
    const entry = standingAfter(previous, run, evidence, project);
    standing.set(key, entry);
    if (entry.streak.runs >= 2) {
        await act(services, key, fetchFn);
        return;
    }
    entry.timer = setTimeout(() => void act(services, key, fetchFn), QUIET_MS);
    entry.timer.unref();
};

// Called for every finished run the webhook or poller sees; only a main-line result moves anything.
export const observeCiRun = async (services: Services, run: PipelineRun, fetchFn: FetchFn = fetch): Promise<void> => {
    if (!MAIN_BRANCHES.has(run.branch)) {
        return;
    }
    if (run.status === "success") {
        const key = keyOf(run.repo, run.branch);
        const cleared = standing.get(key);
        clearTimeout(cleared?.timer);
        standing.delete(key);
        if (cleared !== undefined) {
            tell(services, "ci.repair_retired", `${run.branch} of ${run.repo} went green at ${run.sha.slice(0, 7)}: nothing left to repair on ${cleared.streak.jobs.join(", ")}.`);
        }
        return;
    }
    if (run.status === "failed") {
        await reddened(services, run, fetchFn);
    }
};

// Test seam: forget every streak and re-run, as a restart does.
export const resetRepairGate = (): void => {
    for (const entry of standing.values()) {
        clearTimeout(entry.timer);
    }
    standing.clear();
    rerunOnce.clear();
};

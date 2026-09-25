import { ciFixConversationId, fixStance, fnvDigest, nextStreak, type PipelineRun } from "@intentic/sandbox-contract";
import type { CiRed } from "./ci-store.js";
import type { Services } from "../composition.js";
import { type CiFailureEvidence, ciFailureEvidence, startCiFix } from "./ci-fix.js";
import { ciProjects, type CiProject } from "./projects.js";
import { ciClientFor, type FetchFn } from "./providers.js";

// Main's CI red is repaired only once it is main's newest word: a fleet failure is re-run once, and a code failure gets one
// fix agent when the same jobs fail twice running or main sits red with nothing newer for QUIET_MS. The streak is kept as
// the branch's Red in the CI store (ci-store.ts), by the one streak rule (contract, nextStreak), so a restart keeps it:
// its quiet window is armed again at boot (resumeRepairGate), and a fix it started stays its decision.

// How long a red main stands with nothing newer before a fix starts on it; a push inside the window is a newer run.
export const QUIET_MS = 30 * 60_000;
// Branches whose red a repair is for; any other branch is somebody's work in progress.
const MAIN_BRANCHES = new Set(["main", "master"]);
// Runs listed when asking whether anything newer stands on the branch.
const RUNS_LISTED = 15;
// What measured a CI red's findings: its failed jobs, by name.
const CI_SOURCE = "ci";

// A red that main has stood on: the jobs its newest run failed, how many runs running failed overlapping jobs, the run the
// streak began with (the fix's id) and its newest run.
export interface RedStreak {
    readonly jobs: readonly string[];
    readonly runs: number;
    readonly firstRunId: number;
    readonly runId: number;
}

// One completed red run's effect on the streak before it, by the one streak rule: continued when any failed job repeats,
// begun again otherwise.
export const nextRedStreak = (previous: RedStreak | undefined, runId: number, jobs: readonly string[]): RedStreak => {
    const continues = previous !== undefined && jobs.some((job) => previous.jobs.includes(job));
    const streak = nextStreak(previous === undefined ? undefined : { since: previous.firstRunId, count: previous.runs }, true, runId, continues)!;
    return { jobs, runs: streak.count, firstRunId: streak.since, runId };
};

// The streak a branch's Red holds.
const streakOf = (red: CiRed): RedStreak => ({ jobs: red.findings.map(({ text }) => text), runs: red.count, firstRunId: red.firstRunId, runId: red.runId });

// The fix a red's decisions name, if one was started on it.
const startedOn = (red: CiRed): string | undefined => red.decisions.findLast((decision) => decision.kind === "fix-up")?.conversationId;

// What only this process holds: the quiet window's timer and the newest run's evidence, which is fetched again when a
// restart lost it.
const timers = new Map<string, NodeJS.Timeout>();
const evidenceSeen = new Map<string, CiFailureEvidence>();
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
const act = async (services: Services, repo: string, branch: string, fetchFn: FetchFn): Promise<void> => {
    const key = keyOf(repo, branch);
    const red = (await services.ciStore.reds())[key];
    if (red === undefined || startedOn(red) !== undefined || !(await services.sandboxSettings.get()).autoRepair) {
        return;
    }
    const project = (await ciProjects(services)).find((candidate) => candidate.repo === repo);
    if (project === undefined) {
        return;
    }
    // Unlisted runs cannot show this is still the newest word, so no fix starts on them.
    const runs = await ciClientFor(project.account.provider, fetchFn)
        .listRuns(project, RUNS_LISTED)
        .catch((error: unknown) => {
            services.logger.warn({ err: error, repo }, "ci repair: runs not listed, the fix waits for the next red run");
            return undefined;
        });
    if (runs === undefined) {
        return;
    }
    const newest = runs.filter((run) => run.branch === branch).toSorted((left, right) => right.createdAt - left.createdAt)[0];
    if ((newest !== undefined && newest.runId !== red.runId) || fixInFlight(services, repo)) {
        return;
    }
    const evidence = evidenceSeen.get(key) ?? (await ciFailureEvidence(project, red.runId, services.logger, fetchFn));
    const outcome = await startCiFix(
        services,
        {
            project,
            runId: red.firstRunId,
            evidence,
            byPerson: false,
            preface: `Nobody pressed Fix: ${branch} has stayed red on this failure for ${red.count} run(s) and nothing newer is running, so this is the failure ${branch} stands on. The logs are from its newest run, ${red.runId}.`,
        },
        fetchFn,
    ).catch((error: unknown) => {
        services.logger.warn({ err: error, repo }, "ci repair: the fix did not start");
        return undefined;
    });
    if (outcome?.kind === "started") {
        const decision = { kind: "fix-up" as const, conversationId: outcome.conversationId, at: Date.now(), detail: "Main stood red on it: a fix agent was started." };
        await services.ciStore.red(repo, branch, (current) => (current?.firstRunId === red.firstRunId ? { ...current, decisions: [...current.decisions, decision] } : current));
        tell(services, "ci.repair_started", `${branch} of ${repo} stayed red on ${red.findings.map(({ text }) => text).join(", ")}: a fix agent is on it.`);
    }
};

// Waits out the quiet window, `at` from now, then acts.
const arm = (services: Services, repo: string, branch: string, at: number, fetchFn: FetchFn): void => {
    const key = keyOf(repo, branch);
    clearTimeout(timers.get(key));
    const timer = setTimeout(() => void act(services, repo, branch, fetchFn), Math.max(0, at - Date.now()));
    timer.unref();
    timers.set(key, timer);
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

// The branch's Red after one more red run, by the one streak rule; a fix already started stays its decision while the
// streak it answers runs on.
const redAfter = (previous: CiRed | undefined, run: PipelineRun, jobs: readonly string[]): CiRed => {
    const streak = nextRedStreak(previous === undefined ? undefined : streakOf(previous), run.runId, jobs);
    const same = previous !== undefined && streak.firstRunId === previous.firstRunId;
    return {
        since: same ? previous.since : run.createdAt,
        findings: jobs.map((job) => ({ id: fnvDigest(job), source: CI_SOURCE, text: job, recheckable: true })),
        suspects: [],
        named: false,
        decisions: same ? previous.decisions : [],
        count: streak.runs,
        firstRunId: streak.firstRunId,
        runId: run.runId,
        seenAt: Date.now(),
    };
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
    clearTimeout(timers.get(key));
    evidenceSeen.set(key, evidence);
    let red: CiRed | undefined;
    await services.ciStore.red(run.repo, run.branch, (previous) => {
        red = redAfter(previous, run, evidence.failedJobs.length > 0 ? evidence.failedJobs : (run.failedJobs ?? []));
        return red;
    });
    if (red === undefined) {
        return;
    }
    if (red.count >= 2) {
        await act(services, run.repo, run.branch, fetchFn);
        return;
    }
    arm(services, run.repo, run.branch, red.seenAt + QUIET_MS, fetchFn);
};

// Called for every finished run the webhook or poller sees; only a main-line result moves anything.
export const observeCiRun = async (services: Services, run: PipelineRun, fetchFn: FetchFn = fetch): Promise<void> => {
    if (!MAIN_BRANCHES.has(run.branch)) {
        return;
    }
    if (run.status === "success") {
        const key = keyOf(run.repo, run.branch);
        const cleared = (await services.ciStore.reds())[key];
        clearTimeout(timers.get(key));
        timers.delete(key);
        evidenceSeen.delete(key);
        if (cleared !== undefined) {
            await services.ciStore.red(run.repo, run.branch, () => undefined);
            tell(services, "ci.repair_retired", `${run.branch} of ${run.repo} went green at ${run.sha.slice(0, 7)}: nothing left to repair on ${cleared.findings.map(({ text }) => text).join(", ")}.`);
        }
        return;
    }
    if (run.status === "failed") {
        await reddened(services, run, fetchFn);
    }
};

// At boot, main's CI reds the daemon kept: one that stood two runs and has no fix acts now, and one still inside its quiet
// window gets the rest of it.
export const resumeRepairGate = async (services: Services, fetchFn: FetchFn = fetch): Promise<void> => {
    for (const [key, red] of Object.entries(await services.ciStore.reds())) {
        const [repo = "", branch = ""] = key.split("\n");
        if (startedOn(red) !== undefined) {
            continue;
        }
        if (red.count >= 2) {
            await act(services, repo, branch, fetchFn);
            continue;
        }
        arm(services, repo, branch, red.seenAt + QUIET_MS, fetchFn);
    }
};

// Test seam: forget what only this process holds, as a restart does; the reds on file stay.
export const resetRepairGate = (): void => {
    for (const timer of timers.values()) {
        clearTimeout(timer);
    }
    timers.clear();
    evidenceSeen.clear();
    rerunOnce.clear();
};

import type { PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { FIX_LOG_BYTES } from "../ci-fix.js";
import { jobVerdict, machineOf } from "./fleet-verdict.js";
import { orElse, tell } from "../main-ends.js";
import { type FailedJob, heardOf } from "../main-streak.js";
import type { CiProject } from "../projects.js";
import { ciClientFor, type FetchFn } from "../providers.js";

/* MAIN'S FAILED JOBS THE CI FLEET FAILED. main-fixer.ts asks here whether a failed job is the fleet's (fleet-verdict.ts)
   before parking it for the fix agent: a runner that crashed, lost its connection or was shut down starts nobody. A run
   only the fleet failed has its failed jobs re-run once, with a notice naming each job's runner, machine and what
   happened; failing on the fleet again is said and left to the owner. A job that only might be the fleet's (a timeout
   with no step of its own failing) is re-run once first, and is the agent's when the re-run fails it again. */

// A failed job judged the fleet's (or only possibly: `ambiguous`), with what it says happened and where.
interface FleetJob {
    readonly job: FailedJob;
    readonly says: string;
    readonly ambiguous: boolean;
    // The machine its runner ran on, as its log's first lines name it.
    readonly machine?: string;
}

// What only this process holds, as main-fixer.ts's own: the fleet jobs already judged, so a job's log is not read twice
// for them, and the repositories whose token was refused a re-run, said to the log once each. A restart replays the runs
// since main's failure began (resumeMainFixer), which judges them again.
const fleetJobs = new Map<string, FleetJob>();
const rerunRefused = new Set<string>();

const keyOf = (repo: string, job: Pick<FailedJob, "runId" | "jobId">): string => `${repo}/${heardOf(job)}`;

/** Whether the job was judged the fleet's already. */
export const isFleetJob = (repo: string, job: Pick<FailedJob, "runId" | "jobId">): boolean => fleetJobs.has(keyOf(repo, job));

/** The run's failed jobs judged the fleet's, in the order they were heard. */
export const fleetOf = (repo: string, runId: number): readonly FleetJob[] =>
    [...fleetJobs].filter(([key]) => key.startsWith(`${repo}/${runId}/`)).map(([, fleet]) => fleet);

// Each fleet job in the words a notice or a prompt names it by: the job, the runner and machine it ran on, what happened.
const fleetWords = (fleet: readonly FleetJob[]): string =>
    fleet
        .map(({ job, says, machine }) => {
            const where = [job.runner === undefined ? undefined : `runner ${job.runner}`, machine === undefined ? undefined : `on ${machine}`].filter(
                (part) => part !== undefined,
            );
            return `"${job.name}"${where.length === 0 ? "" : ` (${where.join(" ")})`}: ${says}`;
        })
        .join("; ");

/** What the fix agent is told of the run's jobs left out of its list as the fleet's, when there are any. */
export const leftOut = (fleet: readonly FleetJob[]): readonly string[] =>
    fleet.length === 0
        ? []
        : [
              `Left out of that list, as the CI runners' failures rather than the code's: ${fleetWords(fleet)}. They are not yours to fix or to diagnose; the next run measures them again.`,
          ];

/** Whether a failed job is the fleet's, judged from its annotations, steps, reason and log, and kept when it is. A job's
 *  own webhook carries no annotations, so they are read here. One that only might be the fleet's is, until its run has
 *  had its one re-run, unless `ambiguousIsCode` (its run is some code's failure, or could not be re-run). */
export const judgedFleet = async (
    services: Services,
    project: CiProject,
    job: FailedJob,
    log: string,
    ambiguousIsCode: boolean,
    fetchFn: FetchFn,
): Promise<boolean> => {
    const annotations =
        job.annotations ??
        (await orElse(
            services,
            ciClientFor(project.account.provider, fetchFn).annotations(project, job.jobId),
            [],
            "ci repair: the failed job's annotations could not be read",
            { repo: project.repo, jobId: job.jobId },
        ));
    const verdict = jobVerdict({ ...job, annotations }, log.slice(-FIX_LOG_BYTES));
    if (verdict.kind === "code") {
        return false;
    }
    if (verdict.kind === "ambiguous" && (ambiguousIsCode || (await services.ciStore.fleetRerunDone(project.repo, job.runId)))) {
        return false;
    }
    fleetJobs.set(keyOf(project.repo, job), {
        job: { ...job, annotations },
        says: verdict.says,
        ambiguous: verdict.kind === "ambiguous",
        ...opt("machine", machineOf(log)),
    });
    return true;
};

/** A run's jobs that only might be the fleet's, of those it lists now (`jobIds`: a re-run made its jobs anew), forgotten as
 *  the fleet's so they are judged again as the agent's. */
export const releaseAmbiguous = (repo: string, runId: number, jobIds: readonly number[]): readonly FailedJob[] => {
    const released = fleetOf(repo, runId).filter(({ ambiguous, job }) => ambiguous && jobIds.includes(job.jobId));
    for (const { job } of released) {
        fleetJobs.delete(keyOf(repo, job));
    }
    return released.map(({ job }) => job);
};

/** A run only the fleet failed: its failed jobs re-run once, kept on file so a restart that hears of it again does not
 *  re-run it twice, and the owner told which runner did what; failing on the fleet again is said and left to them. When
 *  the token may not re-run, the owner is told so, and the jobs that only might be the fleet's are answered back for the
 *  agent, as before there was a re-run. */
export const rerunFleet = async (services: Services, project: CiProject, run: PipelineRun, fetchFn: FetchFn): Promise<readonly FailedJob[]> => {
    const fleet = fleetOf(run.repo, run.runId);
    const words = fleetWords(fleet);
    if (!(await services.ciStore.fleetRerun(run.repo, run.runId))) {
        tell(
            services,
            "ci.fleet_failed",
            `Run ${run.runId} of ${run.repo} failed on the CI fleet again after a re-run, so nobody was sent: ${words}. The runners need a look, not the code.`,
            "error",
        );
        return [];
    }
    try {
        await ciClientFor(project.account.provider, fetchFn).rerunFailed(project, run.runId);
    } catch (error) {
        if (!rerunRefused.has(run.repo)) {
            rerunRefused.add(run.repo);
            services.logger.warn(
                { repo: run.repo, runId: run.runId, err: error },
                "ci repair: the fleet re-run was refused; runs the fleet failed are left to the owner",
            );
        }
        tell(
            services,
            "ci.fleet_failed",
            `Run ${run.runId} of ${run.repo} failed on the CI fleet, not in the code, and could not be re-run from here: ${words}. Re-run its failed jobs once the runner is back.`,
            "error",
        );
        return releaseAmbiguous(run.repo, run.runId, fleet.map(({ job }) => job.jobId));
    }
    // The re-run makes the run's jobs anew: what its first attempt's said is no word on its next.
    for (const { job } of fleet) {
        fleetJobs.delete(keyOf(run.repo, job));
    }
    tell(
        services,
        "ci.fleet_rerun",
        `Run ${run.runId} of ${run.repo} failed on the CI fleet, not in the code, so nobody was sent: ${words}. Its failed jobs were re-run once.`,
        "ok",
    );
    return [];
};

/** Test seam: forget what only this process holds, as a restart does. */
export const resetMainFleet = (): void => {
    fleetJobs.clear();
    rerunRefused.clear();
};

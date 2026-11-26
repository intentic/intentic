import type { CiDeploymentAnswer, CiDeploymentReport, PipelineJob, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { GitHost } from "../capabilities/cli/git-access.js";
import { cooled } from "./forge-cooldown.js";
import { githubClient } from "./github.js";
import { gitlabClient } from "./gitlab.js";
import type { FetchFn } from "./http.js";
import type { ForgeProject } from "./projects.js";

// What a failed lookup logs: the status github answered with, or why nothing came back at all.
export type LoginLookupWarn = (fields: { readonly status?: number; readonly err?: string }, message: string) => void;

// Delivery target: the daemon's public receiver plus the signing secret (github signs with it, gitlab echoes it as
// X-Gitlab-Token).
export interface HookSpec {
    readonly url: string;
    readonly secret: string;
}

export interface FailedStep {
    readonly job: string;
    // The job's own id, which its log is read by (jobLog).
    readonly id: number;
    // The first step that failed it. Absent where the forge has no steps (GitLab), which reads as the code's own failure.
    readonly step?: string;
    // Every step that failed it, in order: a job whose steps each run whatever the one before concluded can fail
    // several. Absent where the forge has no steps.
    readonly steps?: readonly string[];
    // GitLab's word for why the job failed (`script_failure`, `runner_system_failure`, …), where it gives one; on GitHub,
    // why a job it reports as cancelled is a failure after all (CANCEL_CAUSES): `timed_out` or `runner_unavailable`.
    readonly reason?: string;
    // What the job's check run annotations say, where the forge has them (GitHub): its one word on a runner that died
    // under the job (the pipelines extension's fleet-verdict.ts). Absent where they were not read.
    readonly annotations?: readonly string[];
    // The runner that ran it, by the name its forge knows it by, where the forge says.
    readonly runner?: string;
}

export interface ForgeClient {
    readonly createRepository: (host: GitHost, name: string, owner: string | undefined, warn: LoginLookupWarn) => Promise<string>;
    readonly reportDeployment: (project: ForgeProject, report: CiDeploymentReport) => Promise<CiDeploymentAnswer>;
    // Newest-first normalized runs; failedJobs is not filled here, list calls are the hot path.
    readonly listRuns: (project: ForgeProject, limit: number) => Promise<PipelineRun[]>;
    // Names of the run's failed jobs, the one-extra-call enrichment for failed runs.
    readonly failedJobs: (project: ForgeProject, runId: number) => Promise<string[]>;
    // Each failed job with the step that failed it, where the forge names steps; a runner-owned step (Set up job) says
    // the fleet died, not the code. A job allowed to fail is none of them. Read while the run is still going too: a job
    // that already failed is listed.
    readonly failedSteps: (project: ForgeProject, runId: number) => Promise<FailedStep[]>;
    // Names of the run's jobs that passed: what a run that did not pass as a whole still says of the jobs failing on
    // main (the pipelines extension's main-fixer.ts, recovered).
    readonly passedJobs: (project: ForgeProject, runId: number) => Promise<string[]>;
    // One run by its id, however old: the list calls reach only the newest.
    readonly run: (project: ForgeProject, runId: number) => Promise<PipelineRun>;
    // A fresh run of the run's workflow on its branch as it is now, rather than the old commit again. GitHub refuses a
    // workflow that takes no manual start (`workflow_dispatch`).
    readonly dispatch: (project: ForgeProject, runId: number) => Promise<void>;
    // All jobs in a run with their individual statuses, the expanded-row enrichment for the view, as the forge reports
    // them. (2026-11-26) The graph GitHub draws from the workflow file is the Pipelines board's backend's to draw, from
    // `workflowSource` below (the pipelines extension's workflow-graph.ts).
    readonly allJobs: (project: ForgeProject, runId: number) => Promise<PipelineJob[]>;
    // The workflow file a run ran, at its commit, and each reusable workflow it calls that could be read, by the key its
    // call names it with; undefined where the forge has none (GitLab) or it could not be read.
    readonly workflowSource: (project: ForgeProject, runId: number) => Promise<WorkflowSource | undefined>;
    // One job's log, reduced to plain text (plain-text.ts) and cut to its last `maxBytes` (Infinity reads it whole); an
    // expired or unreadable log says so in its place.
    readonly jobLog: (project: ForgeProject, jobId: number, maxBytes: number) => Promise<string>;
    readonly rerun: (project: ForgeProject, runId: number) => Promise<void>;
    // The run's failed jobs again, on the same commit, and nothing else: what a run the fleet failed gets, once.
    readonly rerunFailed: (project: ForgeProject, runId: number) => Promise<void>;
    // One job's check run annotations, where the forge has them (GitHub); empty where it has none or did not say.
    readonly annotations: (project: ForgeProject, jobId: number) => Promise<readonly string[]>;
    readonly cancel: (project: ForgeProject, runId: number) => Promise<void>;
    // Idempotent: a hook already delivering to spec.url is left alone, otherwise one is created.
    readonly ensureHook: (project: ForgeProject, spec: HookSpec) => Promise<void>;
    // Best-effort inverse; a hook is identified by its delivery url alone.
    readonly removeHook: (project: ForgeProject, url: string) => Promise<void>;
    // The forge's own word on the project, through any redirect a rename left: its stable id, where it lives now, and
    // its default branch.
    readonly repository: (project: ForgeProject) => Promise<ForgeRepository>;
    readonly projectUrl: (project: ForgeProject) => string;
}

export interface ForgeRepository {
    readonly id: number;
    readonly path: string;
    readonly defaultBranch?: string | undefined;
}

export interface WorkflowSource {
    readonly root: string;
    // Reusable workflows the root calls, by the key the call names them with; the graph needs their jobs too.
    readonly called: ReadonlyMap<string, string>;
}

export const forgeClientFor = (host: GitHost["provider"], fetchFn: FetchFn = fetch): ForgeClient =>
    cooled(host === "github" ? githubClient(fetchFn) : gitlabClient(fetchFn), fetchFn);

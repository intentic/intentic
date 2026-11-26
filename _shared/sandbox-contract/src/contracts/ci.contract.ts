import { procedure } from "../protocol/route-meta.js";
import {
    CiDeploymentAnswerSchema,
    CiDeploymentReportSchema,
    CiFailedStepsResponseSchema,
    CiJobAnnotationsResponseSchema,
    CiJobLogResponseSchema,
    CiJobParamSchema,
    CiJobsResponseSchema,
    CiLocalMainResponseSchema,
    CiMainLineClaimSchema,
    CiMainLinesResponseSchema,
    CiPassedJobsResponseSchema,
    CiRepairHandOverSchema,
    CiRunListParamSchema,
    CiRunListResponseSchema,
    CiRunParamSchema,
    CiRunResponseSchema,
    CiRunsResponseSchema,
    CiRunWorkflowResponseSchema,
} from "../schemas/ci.js";
import { OkSchema } from "../schemas/shared.js";

// Pipelines on the workspace repos' github/gitlab remotes: CI ingestion, the core's (docs/architecture/core-and-
// extensions.md). `runs` serves what the forges report (cache + on-demand backfill; per-repo webhook warnings ride along);
// `rerun`/`cancel`/`dispatch` proxy to the vendor; the forge reads below them are what the pipelines extension's backend
// (main's fix agent and the Pipelines board) reads through the core's clients and credentials. (2026-11-26) Main's fix
// agent, `GET /ci/main`, `POST /ci/failures/forget` and `POST /ci/fix` moved to that backend. The public webhook receiver
// (/ci/webhook/:host) is a plain Hono route, vendors can't do Google ID tokens, so it lives outside this contract, like
// /automations/{id}/fire.
export const ciContract = {
    runs: procedure
        .route({
            method: "GET",
            path: "/ci/runs",
            summary: "Pipeline runs across the repos",
            description:
                "What the forges are reporting for every workspace repo that has a remote, served from a cache and filled in on demand. Repos whose notifications are not wired up say so.",
        })
        .output(CiRunsResponseSchema),
    rerun: procedure
        .route({
            method: "POST",
            path: "/ci/runs/rerun",
            summary: "Run a pipeline again",
            description: "Asks the forge to re-run one pipeline. The daemon only passes the request along.",
        })
        .input(CiRunParamSchema)
        .output(OkSchema),
    cancel: procedure
        .route({
            method: "POST",
            path: "/ci/runs/cancel",
            summary: "Cancel a pipeline run",
            description: "Asks the forge to stop a run in progress.",
        })
        .input(CiRunParamSchema)
        .output(OkSchema),
    dispatch: procedure
        .route({
            method: "POST",
            path: "/ci/runs/dispatch",
            summary: "Run a workflow again on its branch's newest commit",
            description:
                "Starts a fresh run of the workflow the given run belongs to, on that run's branch as it is now, rather than re-running the old commit. On GitHub the workflow must accept a manual start (`workflow_dispatch`); the forge's refusal comes back as it said it.",
        })
        .input(CiRunParamSchema)
        .output(OkSchema),
    jobs: procedure
        .route({
            method: "POST",
            path: "/ci/runs/jobs",
            summary: "The steps inside one pipeline run",
            description:
                "Each job in a run with its outcome, which is where you look to find out what actually broke. The jobs as the forge reports them; the Pipelines board draws their graph from the run's workflow file.",
        })
        .input(CiRunParamSchema)
        .output(CiJobsResponseSchema),
    // (2026-11-26) The forge's word on one run or job, asked now through the core's client (schemas/ci.ts): what main's
    // fix agent reads of a failure, and the board of a run's graph.
    list: procedure
        .route({ method: "POST", path: "/ci/runs/list", summary: "A repository's newest runs", description: "Its newest runs, asked of the forge now rather than read from the cache." })
        .input(CiRunListParamSchema)
        .output(CiRunListResponseSchema),
    run: procedure
        .route({ method: "POST", path: "/ci/runs/run", summary: "One pipeline run", description: "One run as the forge says it is now." })
        .input(CiRunParamSchema)
        .output(CiRunResponseSchema),
    failedSteps: procedure
        .route({
            method: "POST",
            path: "/ci/runs/failed-steps",
            summary: "The failed jobs of one run",
            description: "Each job of the run that failed, with the steps that failed it, the forge's reason and its runner, in the run's order. A job allowed to fail is none of them.",
        })
        .input(CiRunParamSchema)
        .output(CiFailedStepsResponseSchema),
    passedJobs: procedure
        .route({ method: "POST", path: "/ci/runs/passed-jobs", summary: "The passed jobs of one run", description: "The names of the run's jobs that passed." })
        .input(CiRunParamSchema)
        .output(CiPassedJobsResponseSchema),
    rerunFailed: procedure
        .route({ method: "POST", path: "/ci/runs/rerun-failed", summary: "Run a pipeline's failed jobs again", description: "Asks the forge to re-run only the run's failed jobs." })
        .input(CiRunParamSchema)
        .output(OkSchema),
    workflow: procedure
        .route({
            method: "POST",
            path: "/ci/runs/workflow",
            summary: "The workflow file a run ran",
            description: "The run's workflow file at its commit and every reusable workflow it calls that could be read: what its job graph is drawn from. Empty on a forge without one.",
        })
        .input(CiRunParamSchema)
        .output(CiRunWorkflowResponseSchema),
    jobLog: procedure
        .route({ method: "POST", path: "/ci/jobs/log", summary: "One job's log", description: "The job's whole log as plain text, asked of the forge now." })
        .input(CiJobParamSchema)
        .output(CiJobLogResponseSchema),
    jobAnnotations: procedure
        .route({ method: "POST", path: "/ci/jobs/annotations", summary: "One job's annotations", description: "What the job's check run annotations say, where the forge has them." })
        .input(CiJobParamSchema)
        .output(CiJobAnnotationsResponseSchema),
    mainLines: procedure
        .route({
            method: "GET",
            path: "/ci/main-lines",
            summary: "Each repository's main line",
            description: "Every repository wired to CI and which branch is its main line: the forge's default branch, else the clone's, else main and master both.",
        })
        .output(CiMainLinesResponseSchema),
    // (2026-11-26) Only an extension's own token: the claim is the calling extension's (ci/main-line-claims.ts).
    claimMainLines: procedure
        .route({
            method: "POST",
            path: "/ci/main-lines/claim",
            summary: "Take main lines' failures for an extension",
            description:
                "While the calling extension holds the claim and is switched on, a main line's failure reaches no CI automation listening on every branch, so the extension's own fix agent is the one agent on it. An extension's own token only.",
        })
        .meta({ control: "never", panel: false })
        .input(CiMainLineClaimSchema)
        .output(OkSchema),
    // (2026-11-26) What main's repair kept while it was the daemon's, handed to the extension taking it over, once.
    handOverRepair: procedure
        .route({
            method: "POST",
            path: "/ci/repair/hand-over",
            summary: "Hand main's repair state to an extension",
            description:
                "What the sandbox kept about main's failing CI before its repair moved into an extension: each failing main line with its fix agent and turn counts, the passes, the fleet re-runs and the owner steps. The fix agents' runs become the calling extension's to hear, and an owner's switch that turned repairs off becomes its own setting of the same name. An extension's own token only.",
        })
        .meta({ control: "never", panel: false })
        .output(CiRepairHandOverSchema),
    // The agent token reaches it (`agents ci`): beside main's CI, which the pipelines extension follows, what this
    // sandbox's own test runs saw fail at main commits (output-cleaners' test outcomes, under the history root).
    localMain: procedure
        .route({
            method: "GET",
            path: "/ci/main/local",
            summary: "What this sandbox's own test runs saw fail at main",
            description:
                "What the test runs recorded on clean trees at main commits saw fail, newest main commit per repository, suites CI does not run included: rows, and the same in words.",
        })
        .meta({ agent: true })
        .output(CiLocalMainResponseSchema),
    // (2026-11-25) A deployment told to the repository's forge (schemas/ci.ts CiDeploymentReportSchema): how the
    // Deployments extension shows a managed stack's deploys on GitHub or GitLab, through the CI board's own connection.
    reportDeployment: procedure
        .route({
            method: "POST",
            path: "/ci/deployments",
            summary: "Tell the forge a commit was deployed",
            description:
                "Shows on the repository's forge that a commit went to an environment and how it is going: a Deployment and its statuses on GitHub, a `deploy/<environment>` commit status on GitLab. A token without the scope is refused in the forge's own words.",
        })
        .meta({ control: "never", panel: false })
        .input(CiDeploymentReportSchema)
        .output(CiDeploymentAnswerSchema),
};

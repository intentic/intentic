import { procedure } from "../protocol/route-meta.js";
import {
    CiDeploymentAnswerSchema,
    CiDeploymentReportSchema,
    CiFixParamSchema,
    CiFixResponseSchema,
    CiForgetParamSchema,
    CiJobsResponseSchema,
    CiMainResponseSchema,
    CiRunParamSchema,
    CiRunsResponseSchema,
} from "../schemas/ci.js";
import { OkSchema } from "../schemas/shared.js";

// Pipelines on the workspace repos' github/gitlab remotes. `runs` serves the Pipelines rail view (cache +
// on-demand backfill; per-repo webhook warnings ride along); `rerun`/`cancel` proxy to the vendor; `fix`
// opens an isolated agent conversation seeded with the failure context. The public webhook receiver
// (/ci/webhook/:host) is a plain Hono route, vendors can't do Google ID tokens, so it lives outside this
// contract, like /automations/{id}/fire.
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
    // The agent token reaches it (`agents ci`): what an agent meeting a failure asks before blaming itself or re-running
    // main. Read from the CI store alone, never the forge, so any number of agents asking costs no API call.
    main: procedure
        .route({
            method: "GET",
            path: "/ci/main",
            summary: "What main's CI is known to fail on now",
            description:
                "Each job failing on a workspace repository's main line, with the run and commit it last failed in, when the daemon read it, and the failing tests and errors its log named. Answered from the runs already heard, without asking the forge; a main line nothing is known of says so.",
        })
        .meta({ agent: true })
        .output(CiMainResponseSchema),
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
    forget: procedure
        .route({
            method: "POST",
            path: "/ci/failures/forget",
            summary: "Stop tracking a failing workflow on a main-line branch",
            description:
                "Takes one workflow off the branch's failure, or the whole failure when none is named, without waiting for a run to pass. For a workflow that will not run again, or a failure that is not the code's.",
        })
        .input(CiForgetParamSchema)
        .output(OkSchema),
    jobs: procedure
        .route({
            method: "POST",
            path: "/ci/runs/jobs",
            summary: "The steps inside one pipeline run",
            description: "Each job in a run with its outcome, which is where you look to find out what actually broke.",
        })
        .input(CiRunParamSchema)
        .output(CiJobsResponseSchema),
    fix: procedure
        .route({
            method: "POST",
            path: "/ci/fix",
            summary: "Put an agent on a broken pipeline",
            description:
                "Opens a fresh isolated conversation already holding the failure: which job, which repo, what it said. The answer names the conversation so you can open it.",
        })
        .input(CiFixParamSchema)
        .output(CiFixResponseSchema),
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

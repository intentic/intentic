import { oc } from "@orpc/contract";
import {
    CiFixParamSchema,
    CiFixResponseSchema,
    CiJobsResponseSchema,
    CiRunParamSchema,
    CiRunsResponseSchema,
    CiSeenResponseSchema,
} from "../schemas/ci.js";
import { OkSchema } from "../schemas/shared.js";

// Pipelines on the workspace repos' github/gitlab remotes. `runs` serves the Pipelines rail view (cache +
// on-demand backfill; per-repo webhook warnings ride along); `rerun`/`cancel` proxy to the vendor; `fix`
// opens an isolated agent conversation seeded with the failure context. The public webhook receiver
// (/ci/webhook/:host) is a plain Hono route, vendors can't do Google ID tokens, so it lives outside this
// contract, like /automations/{id}/fire.
export const ciContract = {
    runs: oc
        .route({
            method: "GET",
            path: "/ci/runs",
            summary: "Pipeline runs across the repos",
            description:
                "What the forges are reporting for every workspace repo that has a remote, served from a cache and filled in on demand. Repos whose notifications are not wired up say so.",
        })
        .output(CiRunsResponseSchema),
    rerun: oc
        .route({
            method: "POST",
            path: "/ci/runs/rerun",
            summary: "Run a pipeline again",
            description: "Asks the forge to re-run one pipeline. The daemon only passes the request along.",
        })
        .input(CiRunParamSchema)
        .output(OkSchema),
    cancel: oc
        .route({
            method: "POST",
            path: "/ci/runs/cancel",
            summary: "Cancel a pipeline run",
            description: "Asks the forge to stop a run in progress.",
        })
        .input(CiRunParamSchema)
        .output(OkSchema),
    jobs: oc
        .route({
            method: "POST",
            path: "/ci/runs/jobs",
            summary: "The steps inside one pipeline run",
            description: "Each job in a run with its outcome, which is where you look to find out what actually broke.",
        })
        .input(CiRunParamSchema)
        .output(CiJobsResponseSchema),
    fix: oc
        .route({
            method: "POST",
            path: "/ci/fix",
            summary: "Put an agent on a broken pipeline",
            description:
                "Opens a fresh isolated conversation already holding the failure: which job, which repo, what it said. The answer names the conversation so you can open it.",
        })
        .input(CiFixParamSchema)
        .output(CiFixResponseSchema),
    // "I have looked at the pipelines", what silences the rail badge for breakages already read. No input:
    // the surface is read as a whole, and the daemon stamps its own clock so a skewed browser can't mark
    // future failures as already seen.
    seen: oc
        .route({
            method: "POST",
            path: "/ci/seen",
            summary: "Mark the pipelines as read",
            description:
                "Silences the badge for breakages already looked at. Takes nothing, because the view is read as a whole, and the daemon stamps its own clock so a browser with the wrong time cannot mark future failures as already seen.",
        })
        .output(CiSeenResponseSchema),
};

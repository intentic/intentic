import { oc } from "@orpc/contract";
import {
    CiFixParamSchema,
    CiFixResponseSchema,
    CiJobsResponseSchema,
    CiRunParamSchema,
    CiRunsResponseSchema,
    CiSeenResponseSchema,
    OkSchema,
} from "../schemas.js";

// Pipelines on the workspace repos' github/gitlab remotes. `runs` serves the Pipelines rail view (cache +
// on-demand backfill; per-repo webhook warnings ride along); `rerun`/`cancel` proxy to the vendor; `fix`
// opens an isolated agent conversation seeded with the failure context. The public webhook receiver
// (/ci/webhook/:host) is a plain Hono route — vendors can't do Google ID tokens — so it lives outside this
// contract, like /automations/{id}/fire.
export const ciContract = {
    runs: oc.route({ method: "GET", path: "/ci/runs" }).output(CiRunsResponseSchema),
    rerun: oc.route({ method: "POST", path: "/ci/runs/rerun" }).input(CiRunParamSchema).output(OkSchema),
    cancel: oc.route({ method: "POST", path: "/ci/runs/cancel" }).input(CiRunParamSchema).output(OkSchema),
    jobs: oc.route({ method: "POST", path: "/ci/runs/jobs" }).input(CiRunParamSchema).output(CiJobsResponseSchema),
    fix: oc.route({ method: "POST", path: "/ci/fix" }).input(CiFixParamSchema).output(CiFixResponseSchema),
    // "I have looked at the pipelines" — what silences the rail badge for breakages already read. No input:
    // the surface is read as a whole, and the daemon stamps its own clock so a skewed browser can't mark
    // future failures as already seen.
    seen: oc.route({ method: "POST", path: "/ci/seen" }).output(CiSeenResponseSchema),
};

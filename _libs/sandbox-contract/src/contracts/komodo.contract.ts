import { oc } from "@orpc/contract";
import {
    DeployActionParamSchema,
    DeployCapabilityParamSchema,
    DeployFixResponseSchema,
    DeployLogsParamSchema,
    DeployLogsResponseSchema,
    DeployOverviewResponseSchema,
    DeploySeenResponseSchema,
    OkSchema,
} from "../schemas.js";

// The Deployments rail view's whole backend, over a connected `komodo` cli capability. Routes are keyed by
// capability id because a sandbox can hold more than one Komodo connection, and the credential the daemon
// resolves per call is the one the path names — the browser holds neither half of the API key, which is why
// these exist at all rather than the view calling Komodo directly.
export const komodoContract = {
    // One fan-out: deployments + stacks + servers + the alert log, in a single round trip. A Komodo that does
    // not answer resolves with `reachable: false` rather than throwing — "we cannot see it" is a state the
    // view renders, not an error that blanks it.
    overview: oc
        .route({ method: "GET", path: "/komodo/{capability}/overview" })
        .input(DeployCapabilityParamSchema)
        .output(DeployOverviewResponseSchema),
    action: oc.route({ method: "POST", path: "/komodo/{capability}/action" }).input(DeployActionParamSchema).output(OkSchema),
    logs: oc.route({ method: "POST", path: "/komodo/{capability}/logs" }).input(DeployLogsParamSchema).output(DeployLogsResponseSchema),
    fix: oc.route({ method: "POST", path: "/komodo/{capability}/fix" }).input(DeployLogsParamSchema).output(DeployFixResponseSchema),
    // "I have looked at this connection's deployments" — what silences the rail badge for incidents already
    // read. Per capability, since each tile is its own surface, and the daemon stamps its own clock so a
    // skewed browser cannot mark future breakages as already seen.
    seen: oc.route({ method: "POST", path: "/komodo/{capability}/seen" }).input(DeployCapabilityParamSchema).output(DeploySeenResponseSchema),
};

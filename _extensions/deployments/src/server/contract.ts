import { oc } from "@orpc/contract";
import { z } from "zod";
import {
    DeployActionParamSchema,
    DeployCapabilityParamSchema,
    DeployFixParamSchema,
    DeployFixResponseSchema,
    DeployLinkParamSchema,
    DeployLogsParamSchema,
    DeployLogsResponseSchema,
    DeployOverviewResponseSchema,
    DeploySeenResponseSchema,
} from "../contract.js";

const OkSchema = z.object({ ok: z.literal(true) });

// The Deployments rail view's whole backend, over a connected `komodo` cli capability, this extension's own
// contract, served from its /x namespace (the daemon proxies; the host strips the prefix, so these paths are
// what both halves speak). Routes are keyed by capability id because a sandbox can hold more than one Komodo
// connection, and the credential the backend resolves per call is the one the path names, the browser holds
// neither half of the API key, which is why these routes exist rather than the view calling Komodo directly.
export const komodoContract = {
    // One fan-out: deployments + stacks + servers + the alert log, in a single round trip. A Komodo that does
    // not answer resolves with `reachable: false` rather than throwing, "we cannot see it" is a state the
    // view renders, not an error that blanks it.
    overview: oc
        .route({ method: "GET", path: "/komodo/{capability}/overview" })
        .input(DeployCapabilityParamSchema)
        .output(DeployOverviewResponseSchema),
    action: oc.route({ method: "POST", path: "/komodo/{capability}/action" }).input(DeployActionParamSchema).output(OkSchema),
    // Bind a workspace repo to one of this Komodo's stacks (empty `stack` clears it). The backend suggests a
    // match by name; this is the owner accepting it, or choosing a different one.
    link: oc.route({ method: "POST", path: "/komodo/{capability}/link" }).input(DeployLinkParamSchema).output(OkSchema),
    logs: oc.route({ method: "POST", path: "/komodo/{capability}/logs" }).input(DeployLogsParamSchema).output(DeployLogsResponseSchema),
    fix: oc.route({ method: "POST", path: "/komodo/{capability}/fix" }).input(DeployFixParamSchema).output(DeployFixResponseSchema),
    // "I have looked at this connection's deployments", what silences the rail badge for incidents already
    // read. Per capability, since each tile is its own surface, and the backend stamps its own clock so a
    // skewed browser cannot mark future breakages as already seen.
    seen: oc.route({ method: "POST", path: "/komodo/{capability}/seen" }).input(DeployCapabilityParamSchema).output(DeploySeenResponseSchema),
};

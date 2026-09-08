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

// The Deployments rail view's whole backend, served from this extension's /x namespace (the daemon proxies, the host
// strips the prefix). Routes are keyed by capability id, since a sandbox can hold more than one Komodo connection; the
// browser never holds the API key.
export const komodoContract = {
    // One fan-out (deployments, stacks, servers, alerts); unreachable resolves `reachable: false`, not a throw.
    overview: oc
        .route({ method: "GET", path: "/komodo/{capability}/overview" })
        .input(DeployCapabilityParamSchema)
        .output(DeployOverviewResponseSchema),
    action: oc.route({ method: "POST", path: "/komodo/{capability}/action" }).input(DeployActionParamSchema).output(OkSchema),
    // Binds a repo to a stack (empty `stack` clears it); the backend suggests by name, the owner confirms.
    link: oc.route({ method: "POST", path: "/komodo/{capability}/link" }).input(DeployLinkParamSchema).output(OkSchema),
    logs: oc.route({ method: "POST", path: "/komodo/{capability}/logs" }).input(DeployLogsParamSchema).output(DeployLogsResponseSchema),
    fix: oc.route({ method: "POST", path: "/komodo/{capability}/fix" }).input(DeployFixParamSchema).output(DeployFixResponseSchema),
    // Marks this connection read, per capability; backend's own clock, so a skewed browser can't fake it.
    seen: oc.route({ method: "POST", path: "/komodo/{capability}/seen" }).input(DeployCapabilityParamSchema).output(DeploySeenResponseSchema),
};

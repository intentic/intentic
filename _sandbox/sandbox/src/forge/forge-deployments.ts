import { errorMessage } from "@intentic/base/errors";
import type { CiDeploymentAnswer, CiDeploymentReport } from "@intentic/sandbox-contract/schemas/ci";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { forgeClientFor } from "./client.js";
import type { FetchFn } from "./http.js";
import type { ForgeProject } from "./projects.js";
import { CiRateLimited, CiRefused } from "./refusals.js";

/* A DEPLOYMENT TOLD TO THE REPOSITORY'S FORGE (schemas/ci.ts CiDeploymentReportSchema, `POST /ci/deployments`), with the
   token of the GitHub or GitLab connection the CI board already maps the repository to (ci/projects.ts):
   - GitHub: a Deployment of the commit to the environment, created by the first report (which answers its id), then a
     status per report: `in_progress`, `success`, `failure` or `inactive`, with the environment's URL and the log's.
   - GitLab: a commit status named `deploy/<environment>`: running, success, failed or canceled.
   The Deployments extension reports its own deploys here, since it holds no forge token. Nothing is retried or
   remembered: a refusal is answered in the forge's own words, with what to give the token when the forge said it may
   not (401, 403 or 404 on a token without the scope). (2026-11-25) Moved here from the daemon's own deploy engine. */

export interface DeploymentReportDeps {
    // The repository's CI project, with its connection's API base and token; undefined when none is connected.
    readonly projectOf: (repo: string) => Promise<ForgeProject | undefined>;
    readonly fetch: FetchFn;
}

// What the owner gives the token, per forge, when the forge said it may not.
const SCOPE = {
    github: "Give the GitHub token Deployments: write",
    gitlab: "Give the GitLab token the api scope",
} as const;

// The forge's own message out of a refusal's body, when it is JSON that has one.
const ForgeMessageSchema = z.object({ message: z.string() });
const forgeWords = (body: string): string => {
    try {
        const parsed = ForgeMessageSchema.safeParse(JSON.parse(body));
        return parsed.success ? parsed.data.message : body;
    } catch {
        // allow(silent-catch): a body that is not JSON is the forge's words as they came
        return body;
    }
};

export const reportDeployment = async (deps: DeploymentReportDeps, report: CiDeploymentReport): Promise<CiDeploymentAnswer> => {
    const project = await deps.projectOf(report.repo);
    if (project === undefined) {
        throw new ORPCError("PRECONDITION_FAILED", {
            message: `"${report.repo}" has no remote on a connected GitHub or GitLab account: connect the one it is pushed to (Capabilities), and its deploys show there.`,
        });
    }
    const host = project.account.provider;
    try {
        return await forgeClientFor(host, deps.fetch).reportDeployment(project, report);
    } catch (error) {
        if (error instanceof CiRefused) {
            const words = `${error.what} (${error.status}): ${forgeWords(error.body)}`;
            const scoped = error.status === 401 || error.status === 403 || error.status === 404;
            throw new ORPCError(scoped ? "FORBIDDEN" : "BAD_GATEWAY", { message: scoped ? `${words}. ${SCOPE[host]} to see deploys there.` : words });
        }
        if (error instanceof CiRateLimited) {
            throw new ORPCError("TOO_MANY_REQUESTS", { message: error.message });
        }
        throw new ORPCError("BAD_GATEWAY", { message: errorMessage(error) });
    }
};

// The report as the route composes it: the repository's project among the CI board's.
export const deploymentReportDeps = (projects: () => Promise<readonly ForgeProject[]>, fetchFn: FetchFn): DeploymentReportDeps => ({
    projectOf: async (repo) => (await projects()).find((project) => project.repo === repo),
    fetch: fetchFn,
});

import { errorMessage } from "@intentic/base/errors";
import type { CiDeploymentAnswer, CiDeploymentReport } from "@intentic/sandbox-contract/schemas/ci";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { githubHeaders } from "../../capabilities/cli/git-access.js";
import { CiRateLimited, CiRefused, throwOn } from "../forge-refusals.js";
import type { CiProject } from "../projects.js";
import type { FetchFn } from "../providers.js";

/* A DEPLOYMENT TOLD TO THE REPOSITORY'S FORGE (schemas/ci.ts CiDeploymentReportSchema, `POST /ci/deployments`), with the
   token of the GitHub or GitLab connection the CI board already maps the repository to (../projects.ts):
   - GitHub: a Deployment of the commit to the environment, created by the first report (which answers its id), then a
     status per report: `in_progress`, `success`, `failure` or `inactive`, with the environment's URL and the log's.
   - GitLab: a commit status named `deploy/<environment>`: running, success, failed or canceled.
   The Deployments extension reports its own deploys here, since it holds no forge token. Nothing is retried or
   remembered: a refusal is answered in the forge's own words, with what to give the token when the forge said it may
   not (401, 403 or 404 on a token without the scope). (2026-11-25) Moved here from the daemon's own deploy engine. */

export interface DeploymentReportDeps {
    // The repository's CI project, with its connection's API base and token; undefined when none is connected.
    readonly projectOf: (repo: string) => Promise<CiProject | undefined>;
    readonly fetch: FetchFn;
}

// GitLab's words for GitHub's states.
const GITLAB_STATES = {
    in_progress: "running",
    success: "success",
    failure: "failed",
    inactive: "canceled",
} as const satisfies Readonly<Record<CiDeploymentReport["state"], string>>;

// What the owner gives the token, per forge, when the forge said it may not.
const SCOPE = {
    github: "Give the GitHub token Deployments: write",
    gitlab: "Give the GitLab token the api scope",
} as const;

// What a report POSTs, as JSON; an absent field is left out.
type ForgeJson = string | number | boolean | readonly ForgeJson[] | { readonly [key: string]: ForgeJson | undefined };
const posted = (body: ForgeJson, headers: Readonly<Record<string, string>>): RequestInit => ({
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...headers, "Content-Type": "application/json" },
});

// What GitHub answers a deployment created, narrowed to the id its statuses go to.
const CreatedSchema = z.object({ id: z.number() });

// The project's own page on the forge (an enterprise host included): where the answer's link points.
const webOf = (project: CiProject): string => `${project.account.scheme}://${project.account.host}/${project.project}`;

const github = async (deps: DeploymentReportDeps, project: CiProject, report: CiDeploymentReport): Promise<CiDeploymentAnswer> => {
    const base = `${project.account.apiBase}/repos/${project.project}`;
    const headers = githubHeaders(project.account.token);
    let deployment = report.deploymentId;
    if (deployment === undefined) {
        const created = await throwOn(
            await deps.fetch(
                `${base}/deployments`,
                posted(
                    {
                        ref: report.sha,
                        environment: report.environment,
                        description: report.description,
                        auto_merge: false,
                        required_contexts: [],
                        transient_environment: false,
                        production_environment: report.production,
                    },
                    headers,
                ),
            ),
            `GitHub refused creating a deployment of ${report.environment}`,
        );
        deployment = CreatedSchema.parse(await created.json()).id;
    }
    const status = { state: report.state, description: report.description, environment_url: report.environmentUrl, log_url: report.logUrl };
    await throwOn(await deps.fetch(`${base}/deployments/${deployment}/statuses`, posted(status, headers)), `GitHub refused a status for deployment ${deployment}`);
    return { deploymentId: deployment, url: `${webOf(project)}/deployments/${encodeURIComponent(report.environment)}` };
};

const gitlab = async (deps: DeploymentReportDeps, project: CiProject, report: CiDeploymentReport): Promise<CiDeploymentAnswer> => {
    const url = `${project.account.apiBase}/projects/${encodeURIComponent(project.project)}/statuses/${report.sha}`;
    const status = { state: GITLAB_STATES[report.state], name: `deploy/${report.environment}`, description: report.description, target_url: report.logUrl };
    await throwOn(await deps.fetch(url, posted(status, { "PRIVATE-TOKEN": project.account.token })), "GitLab refused a commit status");
    return { url: `${webOf(project)}/-/commit/${report.sha}` };
};

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
        return host === "github" ? await github(deps, project, report) : await gitlab(deps, project, report);
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
export const deploymentReportDeps = (projects: () => Promise<readonly CiProject[]>, fetchFn: FetchFn): DeploymentReportDeps => ({
    projectOf: async (repo) => (await projects()).find((project) => project.repo === repo),
    fetch: fetchFn,
});
